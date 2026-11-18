import AppKit
import WebKit

enum PatchCheck {
    static func check(_ patch: String, in folder: URL) throws -> String {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: temporary) }
        let file = temporary.appendingPathComponent("proposed.diff")
        let input = patch.hasSuffix("\n") ? patch : patch + "\n"
        try Data(input.utf8).write(to: file)
        let conventional = input.hasPrefix("diff --git ") || input.contains("\ndiff --git ") ||
            input.range(of: #"(?m)^(--- a/|\+\+\+ b/)"#, options: .regularExpression) != nil
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.currentDirectoryURL = folder
        process.environment = ["PATH": "/usr/bin:/bin", "LC_ALL": "C",
                               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                               "GIT_CEILING_DIRECTORIES": folder.deletingLastPathComponent().path]
        process.arguments = ["-c", "core.quotePath=false", "apply", "--check", "--numstat",
                             "--verbose", conventional ? "-p1" : "-p0", "--", file.path]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let detail = String(decoding: data, as: UTF8.self)
        let valid = process.terminationStatus == 0 && !detail.contains("Skipped patch ") &&
            detail.range(of: #"(?m)^(?:\d+|-)\t(?:\d+|-)\t"#, options: .regularExpression) != nil
        return (valid ? "Патч применим" : "Патч не прошёл проверку") + " · " + folder.lastPathComponent +
            "\n" + String(detail.prefix(6500))
    }
}

@MainActor
final class PatchMessages: NSObject, WKScriptMessageHandlerWithReply {
    private let authorized: (WKScriptMessage) -> Bool
    init(authorized: @escaping (WKScriptMessage) -> Bool) { self.authorized = authorized }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard authorized(message), let window = message.webView?.window, window.attachedSheet == nil,
              let patch = message.body as? String, !patch.isEmpty, patch.utf8.count <= 600_000 else {
            replyHandler(nil, "Не удалось открыть проверку патча.")
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = "Выберите корневую папку проекта для проверки diff по текущим файлам."
        panel.prompt = "Проверить"
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let folder = panel.url else { replyHandler("", nil); return }
            Task {
                do {
                    let output = try await Task.detached { try PatchCheck.check(patch, in: folder) }.value
                    replyHandler(output, nil)
                } catch { replyHandler(nil, "Не удалось запустить проверку Git: " + error.localizedDescription) }
            }
        }
    }
}
