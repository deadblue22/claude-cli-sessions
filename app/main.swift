import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var port = 0

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "CLI Sessions"
        window.contentView = web
        window.delegate = self
        window.setFrameAutosaveName("main")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString("<body style='font:14px -apple-system;color:#888;display:grid;place-items:center;height:90vh'>启动中…</body>", baseURL: nil)
        startServer()
    }

    func findNode() -> String? {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lic", "command -v node"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        // shell 启动脚本可能有杂项输出，取最后一个存在的绝对路径
        for l in out.split(separator: "\n").reversed() {
            let s = l.trimmingCharacters(in: .whitespaces)
            if s.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: s) { return s }
        }
        for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where FileManager.default.isExecutableFile(atPath: c) { return c }
        return nil
    }

    func startServer() {
        DispatchQueue.global().async {
            guard let node = self.findNode() else {
                DispatchQueue.main.async { self.fail("找不到 node，请先安装 Node.js") }; return
            }
            let sock = socket(AF_INET, SOCK_STREAM, 0)
            var a = sockaddr_in(); a.sin_family = sa_family_t(AF_INET); a.sin_addr.s_addr = inet_addr("127.0.0.1"); a.sin_port = 0
            withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            withUnsafeMutablePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = getsockname(sock, $0, &len) } }
            self.port = Int(UInt16(bigEndian: a.sin_port)); close(sock)

            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CLI Sessions")
            try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            let p = Process(); p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [Bundle.main.resourcePath! + "/server.js"]
            p.currentDirectoryURL = URL(fileURLWithPath: Bundle.main.resourcePath!)
            var env = ProcessInfo.processInfo.environment
            env["PORT"] = String(self.port); env["STATE_DIR"] = support.path
            p.environment = env
            p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { DispatchQueue.main.async { self.fail("启动服务失败：\(error)") }; return }
            self.server = p
            let url = URL(string: "http://127.0.0.1:\(self.port)/api/sessions")!
            for _ in 0..<100 {
                if (try? Data(contentsOf: url)) != nil {
                    DispatchQueue.main.async { self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/")!)) }; return
                }
                usleep(100_000)
            }
            DispatchQueue.main.async { self.fail("服务启动超时") }
        }
    }

    func fail(_ m: String) { let a = NSAlert(); a.messageText = m; a.runModal(); NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { server?.terminate() }

    // JS 的 confirm / prompt / alert
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); c()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "确定"); a.addButton(withTitle: "取消")
        c(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = p; a.addButton(withTitle: "确定"); a.addButton(withTitle: "取消")
        let t = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24)); t.stringValue = d ?? ""
        a.accessoryView = t; a.window.initialFirstResponder = t
        c(a.runModal() == .alertFirstButtonReturn ? t.stringValue : nil)
    }

    func buildMenu() {
        let main = NSMenu(); NSApp.mainMenu = main
        func item(_ title: String, _ menu: NSMenu) -> NSMenu { let i = NSMenuItem(); main.addItem(i); i.submenu = menu; menu.title = title; return menu }
        let app = item("App", NSMenu())
        app.addItem(withTitle: "退出 CLI Sessions", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = item("编辑", NSMenu(title: "编辑"))
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let view = item("显示", NSMenu(title: "显示"))
        view.addItem(withTitle: "刷新", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
    }
}

let app = NSApplication.shared
let d = AppDelegate()
app.delegate = d
app.run()
