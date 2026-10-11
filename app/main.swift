import Cocoa
import WebKit

// 界面语言：网页里选过的（存在 UserDefaults）优先，否则用系统首选语言。
// 端口每次启动随机，网页 localStorage 不跨启动保留，所以由壳记住并通过 ?lang= 传回网页。
let uiLang = UserDefaults.standard.string(forKey: "lang") ?? Locale.preferredLanguages.first ?? "en"
// 原生界面字符串：以英文原文为 key 查表（先精确匹配，再按语种）；缺失时回退英文
let STRINGS: [String: [String: String]] = [
    "zh": [
        "Starting…": "启动中…",
        "Node.js not found. Please install Node.js first.": "找不到 node，请先安装 Node.js",
        "Failed to start the server: ": "启动服务失败：",
        "Timed out waiting for the server to start": "服务启动超时",
        "OK": "确定",
        "Cancel": "取消",
        "Quit CLI Sessions": "退出 CLI Sessions",
        "Edit": "编辑",
        "Undo": "撤销",
        "Cut": "剪切",
        "Copy": "拷贝",
        "Paste": "粘贴",
        "Select All": "全选",
        "View": "显示",
        "Reload": "刷新",
    ],
]
func tr(_ en: String) -> String {
    let base = String(uiLang.split(separator: "-").first ?? "en")
    return STRINGS[uiLang]?[en] ?? STRINGS[base]?[en] ?? en
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, NSWindowDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var port = 0

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "lang")
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
        web.loadHTMLString("<body style='font:14px -apple-system;color:#888;display:grid;place-items:center;height:90vh'>\(tr("Starting…"))</body>", baseURL: nil)
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
                DispatchQueue.main.async { self.fail(tr("Node.js not found. Please install Node.js first.")) }; return
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
            do { try p.run() } catch { DispatchQueue.main.async { self.fail(tr("Failed to start the server: ") + "\(error)") }; return }
            self.server = p
            let url = URL(string: "http://127.0.0.1:\(self.port)/api/sessions")!
            for _ in 0..<100 {
                if (try? Data(contentsOf: url)) != nil {
                    DispatchQueue.main.async { self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/?lang=\(uiLang.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "en")")!)) }; return
                }
                usleep(100_000)
            }
            DispatchQueue.main.async { self.fail(tr("Timed out waiting for the server to start")) }
        }
    }

    func fail(_ m: String) { let a = NSAlert(); a.messageText = m; a.runModal(); NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { server?.terminate() }

    // 网页切换语言时记下来，下次启动传回
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
        if m.name == "lang", let s = m.body as? String { UserDefaults.standard.set(s, forKey: "lang") }
    }

    // JS 的 confirm / prompt / alert
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); c()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: tr("OK")); a.addButton(withTitle: tr("Cancel"))
        c(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler c: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = p; a.addButton(withTitle: tr("OK")); a.addButton(withTitle: tr("Cancel"))
        let t = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24)); t.stringValue = d ?? ""
        a.accessoryView = t; a.window.initialFirstResponder = t
        c(a.runModal() == .alertFirstButtonReturn ? t.stringValue : nil)
    }

    func buildMenu() {
        let main = NSMenu(); NSApp.mainMenu = main
        func item(_ title: String, _ menu: NSMenu) -> NSMenu { let i = NSMenuItem(); main.addItem(i); i.submenu = menu; menu.title = title; return menu }
        let app = item("App", NSMenu())
        app.addItem(withTitle: tr("Quit CLI Sessions"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = item(tr("Edit"), NSMenu(title: tr("Edit")))
        edit.addItem(withTitle: tr("Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: tr("Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: tr("Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: tr("Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: tr("Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let view = item(tr("View"), NSMenu(title: tr("View")))
        view.addItem(withTitle: tr("Reload"), action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
    }
}

let app = NSApplication.shared
let d = AppDelegate()
app.delegate = d
app.run()
