import AppKit
import SwiftUI
import WebKit

@main
struct LocalChatApp {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = LocalChatDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

private final class LoopbackSession: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class LocalChatDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSWindowDelegate {
    private let origin = URL(string: "http://127.0.0.1:8771/")!
    private let nonce = UUID().uuidString + UUID().uuidString
    private let backend = Process()
    private let stdinPipe = Pipe()
    private var launched = false
    private var shuttingDown = false
    private var ready = false
    private var window: NSWindow!
    private var web: WKWebView!
    private var desktopWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 795),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "LocalChat"
        window.minSize = NSSize(width: 620, height: 490)
        window.isReleasedWhenClosed = false
        window.center()
        showStartup("Запускаю LocalChat…")
        showMainWindow()
        startBackend()
    }

    private func buildMenu() {
        let bar = NSMenu()
        let app = NSMenuItem()
        app.submenu = NSMenu(title: "LocalChat")
        app.submenu?.addItem(withTitle: "О LocalChat", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.submenu?.addItem(.separator())
        app.submenu?.addItem(withTitle: "Выйти из LocalChat", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        bar.addItem(app)

        let edit = NSMenuItem()
        edit.submenu = NSMenu(title: "Правка")
        let editing = [("Отменить","undo:","z"),("Вырезать","cut:","x"),("Копировать","copy:","c"),
                       ("Вставить","paste:","v"),("Выбрать всё","selectAll:","a")]
        for (name, action, key) in editing {
            edit.submenu?.addItem(withTitle: name, action: Selector(action), keyEquivalent: key)
        }
        bar.addItem(edit)

        let desktop = NSMenuItem()
        desktop.submenu = NSMenu(title: "Экран")
        let item = desktop.submenu!.addItem(withTitle: "Управление окном", action: #selector(openDesktop), keyEquivalent: "d")
        item.keyEquivalentModifierMask = [.command, .shift]
        item.target = self
        bar.addItem(desktop)
        NSApp.mainMenu = bar
    }

    @objc private func showMainWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMainWindow() }
        return true
    }

    private func showStartup(_ message: String) {
        let label = NSTextField(wrappingLabelWithString: message)
        label.font = .systemFont(ofSize: 17, weight: .medium)
        label.alignment = .center
        let view = NSView()
        view.addSubview(label)
        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -60)
        ])
        window.contentView = view
    }

    private func startBackend() {
        guard let runtime = Bundle.main.resourceURL?.appendingPathComponent("Runtime") else { return }
        backend.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        backend.arguments = ["-B", runtime.appendingPathComponent("server.py").path]
        backend.currentDirectoryURL = runtime
        var environment = ProcessInfo.processInfo.environment
        environment["LOCALCHAT_PORT"] = "8771"
        environment["LOCALCHAT_NATIVE_NONCE"] = nonce
        backend.environment = environment
        backend.standardInput = stdinPipe
        backend.standardOutput = FileHandle.nullDevice
        backend.standardError = FileHandle.nullDevice
        backend.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.shuttingDown else { return }
                self.ready = false
                self.web.stopLoading()
                self.showStartup("Локальный сервер остановился. Проверьте, свободен ли порт 8771, и откройте приложение снова.")
            }
        }
        do {
            try backend.run()
            launched = true
        } catch {
            showStartup("Не удалось запустить сервер LocalChat. Проверьте, доступен ли системный Python 3.")
            return
        }
        Task {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.connectionProxyDictionary = [:]
            let session = URLSession(configuration: configuration, delegate: LoopbackSession(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: origin.appendingPathComponent("api/native-health"))
            request.setValue(nonce, forHTTPHeaderField: "X-LocalChat-Native")
            request.timeoutInterval = 0.5
            for _ in 0..<32 {
                guard backend.isRunning else { return }
                if let (_, response) = try? await session.data(for: request),
                   (response as? HTTPURLResponse)?.statusCode == 200, backend.isRunning {
                    ready = true
                    showChat()
                    return
                }
                try? await Task.sleep(for: .milliseconds(120))
            }
            if !ready, backend.isRunning {
                backend.terminate()
                showStartup("Сервер LocalChat не подтвердил запуск. Переоткройте приложение.")
            }
        }
    }

    private func showChat() {
        let root = NSView()
        let control = NSButton(title: "Управление окном", target: self, action: #selector(openDesktop))
        control.bezelStyle = .rounded
        let heading = NSTextField(labelWithString: "LocalChat")
        heading.font = .systemFont(ofSize: 13, weight: .semibold)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let toolbar = NSStackView(views: [heading, spacer, control])
        toolbar.orientation = .horizontal
        toolbar.edgeInsets = NSEdgeInsets(top: 5, left: 15, bottom: 5, right: 12)
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        web.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(toolbar)
        root.addSubview(web)
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: root.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: 39),
            web.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])
        window.contentView = root
        web.load(URLRequest(url: origin))
    }

    private func isInternal(_ url: URL?) -> Bool {
        guard let url else { return false }
        return ready && launched && backend.isRunning && url.scheme == origin.scheme &&
            url.host == origin.host && url.port == origin.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if isInternal(url) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        } else if action.shouldPerformDownload && url?.scheme == "blob" && isInternal(webView.url) {
            decisionHandler(.download)
        } else {
            if let url, url.scheme == "https", action.navigationType == .linkActivated, isInternal(webView.url) {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "https",
           action.navigationType == .linkActivated, isInternal(webView.url) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        if ready && (error as NSError).code != NSURLErrorCancelled {
            showStartup("Не удалось загрузить чат. Переоткройте LocalChat.")
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, isInternal(frame.request.url) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !panel.canChooseDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor securityOrigin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .microphone && frame.isMainFrame && isInternal(frame.request.url) ? .prompt : .deny)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }

    @objc private func openDesktop() {
        if let desktopWindow { desktopWindow.makeKeyAndOrderFront(nil); return }
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 680),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "LocalChat · Управление окном"
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.minSize = NSSize(width: 600, height: 540)
        panel.contentViewController = NSHostingController(rootView: DesktopView { [weak self] jpeg in
            self?.attachCapture(jpeg)
        })
        panel.center()
        desktopWindow = panel
        panel.makeKeyAndOrderFront(nil)
    }

    private func attachCapture(_ jpeg: Data) {
        guard isInternal(web.url) else { return }
        web.callAsyncJavaScript("return attachLocalScreenCapture(data)",
            arguments: ["data": jpeg.base64EncodedString()], in: nil, in: .page) { [weak self] result in
            if case .success(let accepted) = result, accepted as? Bool == true {
                self?.showMainWindow()
            } else {
                let alert = NSAlert()
                alert.messageText = "Не удалось прикрепить снимок"
                alert.informativeText = "Дождитесь ответа в чате или уберите одно из вложений."
                if let panel = self?.desktopWindow { alert.beginSheetModal(for: panel) }
            }
        }
    }

    func windowWillClose(_ notification: Notification) {
        if let closing = notification.object as? NSWindow, closing === desktopWindow {
            closing.contentViewController = nil
            desktopWindow = nil
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        shuttingDown = true
        if launched && backend.isRunning { backend.terminate() }
        try? stdinPipe.fileHandleForWriting.close()
    }
}
