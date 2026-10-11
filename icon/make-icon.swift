import Cocoa
// 生成 1024x1024 图标 PNG：赭红渐变底 + 三层叠放的 session 卡片 + 终端提示符
let S: CGFloat = 1024
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
// macOS 图标内容区 824x824，四周留白
let box = NSRect(x: 100, y: 100, width: 824, height: 824)
let bg = NSBezierPath(roundedRect: box, xRadius: 185, yRadius: 185)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 28, color: NSColor.black.withAlphaComponent(0.3).cgColor)
NSColor.black.setFill(); bg.fill()
ctx.restoreGState()
bg.addClip()
NSGradient(colors: [NSColor(red: 0.89, green: 0.50, blue: 0.33, alpha: 1), NSColor(red: 0.74, green: 0.34, blue: 0.20, alpha: 1)])!.draw(in: box, angle: -60)

func card(_ r: NSRect, alpha: CGFloat) {
    let p = NSBezierPath(roundedRect: r, xRadius: 52, yRadius: 52)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 18, color: NSColor.black.withAlphaComponent(0.18).cgColor)
    NSColor.white.withAlphaComponent(alpha).setFill(); p.fill()
    ctx.restoreGState()
}
card(NSRect(x: 235, y: 640, width: 554, height: 120), alpha: 0.38)
card(NSRect(x: 205, y: 545, width: 614, height: 140), alpha: 0.62)
let front = NSRect(x: 175, y: 255, width: 674, height: 330)
card(front, alpha: 0.97)
// 提示符 >_
let accent = NSColor(red: 0.78, green: 0.39, blue: 0.24, alpha: 1)
let chev = NSBezierPath()
chev.lineWidth = 46; chev.lineCapStyle = .round; chev.lineJoinStyle = .round
chev.move(to: NSPoint(x: 290, y: 482)); chev.line(to: NSPoint(x: 400, y: 420)); chev.line(to: NSPoint(x: 290, y: 358))
accent.setStroke(); chev.stroke()
let us = NSBezierPath(roundedRect: NSRect(x: 440, y: 345, width: 130, height: 40), xRadius: 20, yRadius: 20)
accent.setFill(); us.fill()
// 右侧两条“文字行”
NSColor(red: 0.78, green: 0.39, blue: 0.24, alpha: 0.28).setFill()
NSBezierPath(roundedRect: NSRect(x: 620, y: 455, width: 170, height: 28), xRadius: 14, yRadius: 14).fill()
NSBezierPath(roundedRect: NSRect(x: 650, y: 395, width: 140, height: 28), xRadius: 14, yRadius: 14).fill()
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
