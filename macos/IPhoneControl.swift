import AppKit
import Foundation

@MainActor
final class IPhoneControl {
    private struct Identity: Decodable {
        struct Node: Decodable { let DNSName: String; let UserID: UInt64 }
        struct User: Decodable { let LoginName: String }
        let BackendState: String
        let SelfNode: Node?
        let User: [String: User]
        enum CodingKeys: String, CodingKey { case BackendState, User; case SelfNode = "Self" }
    }

    private struct Status: Decodable {
        struct Command: Decodable {
            let id: String
            let kind: String
            let value: Int?
        }
        let enabled: Bool
        let code: String
        let paired: Bool
        let command: Command?
    }

    private struct ConnectionError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    private static let port = 8780
    private let nonce: String
    private let window: () -> NSWindow?
    private let openDesktop: () -> Void
    private var timer: Task<Void, Never>?
    private var origin: URL?
    private var login: String?
    private var working = false
    private var lastShown: String?
    private weak var pairingSheet: NSWindow?
    private weak var approvalSheet: NSWindow?

    init(nonce: String, window: @escaping () -> NSWindow?, openDesktop: @escaping () -> Void) {
        self.nonce = nonce
        self.window = window
        self.openDesktop = openDesktop
    }

    func show() {
        guard !working, let window = window(), window.attachedSheet == nil else { return }
        if let origin {
            Task {
                working = true
                defer { working = false }
                do {
                    let status = try await request(["action": "status"])
                    showConnection(origin, status: status, attachedTo: window)
                } catch { errorAlert(error, in: window) }
            }
            return
        }
        let alert = NSAlert()
        alert.messageText = "Подключить iPhone"
        alert.informativeText = "mafokenLLM откроет страницу внутри Tailscale. Подключите iPhone к тому же аккаунту Tailscale и введите одноразовый код. Команды управления требуют подтверждения на Mac."
        alert.addButton(withTitle: "Включить доступ")
        alert.addButton(withTitle: "Отмена")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.start(in: window)
        }
    }

    private func start(in window: NSWindow) {
        guard !working else { return }
        working = true
        Task {
            defer { working = false }
            do {
                let identity = try JSONDecoder().decode(Identity.self, from: await Self.cli(["status", "--json"]))
                guard identity.BackendState == "Running", let node = identity.SelfNode,
                      let user = identity.User[String(node.UserID)], !user.LoginName.isEmpty,
                      let address = URL(string: "http://\(node.DNSName.trimmingCharacters(in: CharacterSet(charactersIn: "."))):\(Self.port)")
                else { throw ConnectionError("Войдите в Tailscale на Mac и повторите подключение.") }
                let reuseProxy = try await Self.ownedProxy(for: address)
                let status = try await request(["action": "start", "origin": address.absoluteString, "login": user.LoginName])
                if !reuseProxy {
                    _ = try await Self.cli(["serve", "--bg", "--http=\(Self.port)", Self.target])
                }
                self.origin = address
                self.login = user.LoginName
                lastShown = nil
                beginPolling()
                showConnection(address, status: status, attachedTo: window)
            } catch {
                _ = try? await request(["action": "stop"])
                errorAlert(error, in: window)
            }
        }
    }

    private func showConnection(_ origin: URL, status: Status, attachedTo window: NSWindow) {
        let alert = NSAlert()
        alert.messageText = "iPhone · mafokenLLM"
        let instructions = "Откройте в Safari при включённом Tailscale:\n\(origin.absoluteString)"
        alert.informativeText = instructions + (status.paired ? "\n\nТелефон подключён."
            : status.code.isEmpty ? "\n\nСрок кода истёк. Создайте новый." : "\n\nКод на пять минут: \(status.code)")
        alert.addButton(withTitle: "Готово")
        alert.addButton(withTitle: "Скопировать адрес")
        alert.addButton(withTitle: "Новый код")
        alert.addButton(withTitle: "Отключить доступ")
        if !status.paired { pairingSheet = alert.window }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            switch response {
            case .alertSecondButtonReturn:
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(origin.absoluteString, forType: .string)
            case .alertThirdButtonReturn:
                self.renew(in: window)
            default:
                if response.rawValue == NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + 3 {
                    Task { await self.stop() }
                }
            }
        }
    }

    private func beginPolling() {
        timer?.cancel()
        timer = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.2))
                guard !Task.isCancelled else { break }
                guard let status = try? await request(["action": "status"]), !Task.isCancelled else { continue }
                updateConnection(status)
            }
        }
    }

    private func updateConnection(_ status: Status) {
        if status.paired, let sheet = pairingSheet, let parent = sheet.sheetParent {
            pairingSheet = nil
            parent.endSheet(sheet, returnCode: .alertFirstButtonReturn)
        }
        if status.command?.id != lastShown, let sheet = approvalSheet, let parent = sheet.sheetParent {
            approvalSheet = nil
            parent.endSheet(sheet, returnCode: .cancel)
        }
        if let command = status.command { present(command) }
    }

    private func present(_ command: Status.Command) {
        guard lastShown != command.id, let window = window(), window.attachedSheet == nil else { return }
        let text: String
        switch command.kind {
        case "desktop": text = "Открыть панель «Управление Mac»"
        case "screenshot": text = "Сделать снимок основного дисплея и отправить его на сопряжённый iPhone."
        case "mute": text = "Выключить звук"
        case "unmute": text = "Включить звук"
        case "volume": text = "Установить громкость на \(command.value ?? 0) %"
        default: return
        }
        lastShown = command.id
        let alert = NSAlert()
        alert.messageText = "Запрос с iPhone"
        alert.informativeText = text
        alert.addButton(withTitle: "Выполнить")
        alert.addButton(withTitle: "Отклонить")
        approvalSheet = alert.window
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            Task {
                let action = response == .alertFirstButtonReturn ? "approve" : "status"
                guard let status = try? await self.request(["action": action, "id": command.id]),
                      status.command?.id == command.id else { return }
                var message = "Запрос отклонён на Mac."
                var result: [String: Any] = ["action":"result", "id":command.id]
                if response == .alertFirstButtonReturn {
                    if command.kind == "desktop" {
                        self.openDesktop()
                        message = "Панель управления открыта на Mac."
                    } else if command.kind == "screenshot" {
                        do {
                            let bytes = try await captureIPhoneScreen()
                            result["jpeg"] = bytes.base64EncodedString()
                            message = "Снимок основного дисплея готов."
                        } catch { message = error.localizedDescription }
                    } else {
                        message = performIPhoneAudio(command.kind, value: command.value)
                    }
                }
                result["message"] = message
                _ = try? await self.request(result)
            }
        }
    }

    private func renew(in window: NSWindow) {
        guard !working, let origin, let login else { return }
        working = true
        Task {
            defer { working = false }
            do {
                let status = try await request(["action": "start", "origin": origin.absoluteString, "login": login])
                lastShown = nil
                showConnection(origin, status: status, attachedTo: window)
            } catch { errorAlert(error, in: window) }
        }
    }

    private func stop() async {
        guard !working, let address = origin else { return }
        working = true
        defer { working = false }
        timer?.cancel()
        timer = nil
        origin = nil
        login = nil
        _ = try? await request(["action": "stop"])
        if (try? await Self.ownedProxy(for: address)) == true {
            _ = try? await Self.cli(["serve", "--http=\(Self.port)", "off"])
        }
    }

    private static let target = "http://127.0.0.1:8772"

    private static func ownedProxy(for address: URL) async throws -> Bool {
        let raw = try await cli(["serve", "status", "--json"])
        guard let config = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            throw ConnectionError("Не удалось проверить настройки Tailscale Serve.")
        }
        let ports = config["TCP"] as? [String: Any] ?? [:]
        guard ports[String(port)] != nil else { return false }
        let web = config["Web"] as? [String: [String: Any]] ?? [:]
        let authority = "\(address.host ?? ""):\(port)"
        let handlers = web[authority]?["Handlers"] as? [String: [String: Any]] ?? [:]
        let allowFunnel = config["AllowFunnel"] as? [String: Bool] ?? [:]
        if handlers.count == 1, handlers["/"]?["Proxy"] as? String == target, allowFunnel[authority] != true {
            return true
        }
        throw ConnectionError("Порт \(port) уже используется Tailscale Serve. Освободите его перед подключением iPhone.")
    }

    private func request(_ body: [String: Any]) async throws -> Status {
        let url = URL(string: "http://127.0.0.1:8771/api/iphone")!
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(nonce, forHTTPHeaderField: "X-LocalChat-Native")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ConnectionError("Панель iPhone недоступна. Проверьте, свободен ли порт 8772 на Mac.")
        }
        return try JSONDecoder().decode(Status.self, from: data)
    }

    private nonisolated static func cli(_ arguments: [String]) async throws -> Data {
        try await Task.detached {
            let url = URL(fileURLWithPath: "/Applications/Tailscale.app/Contents/MacOS/Tailscale")
            guard FileManager.default.isExecutableFile(atPath: url.path) else {
                throw ConnectionError("Установите Tailscale на Mac и войдите в свой аккаунт.")
            }
            let process = Process()
            let output = Pipe()
            process.executableURL = url
            process.arguments = arguments
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = output
            process.standardError = output
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                throw ConnectionError("Tailscale не смог открыть локальный сервис. Проверьте настройки Tailscale Serve.")
            }
            return data
        }.value
    }

    private func errorAlert(_ error: Error, in window: NSWindow) {
        let alert = NSAlert()
        alert.messageText = "Не удалось подключить iPhone"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }
}
