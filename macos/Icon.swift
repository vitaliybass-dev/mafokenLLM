import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for side in [16, 32, 128, 256, 512] {
    for density in [1, 2] {
        let pixels = side * density
        let image = NSImage(size: NSSize(width: pixels, height: pixels), flipped: false) { rect in
            let tile = rect.insetBy(dx: rect.width * 0.10, dy: rect.height * 0.10)
            let shape = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.23, yRadius: tile.width * 0.23)
            let ink = NSColor(srgbRed: 0.63, green: 0.98, blue: 0.83, alpha: 1)
            NSGradient(starting: NSColor(srgbRed: 0.09, green: 0.26, blue: 0.22, alpha: 1),
                       ending: NSColor(srgbRed: 0.04, green: 0.10, blue: 0.12, alpha: 1))?.draw(in: shape, angle: -90)
            let scale = tile.width
            let base = CGPoint(x: tile.midX, y: tile.midY)
            let cursor = NSBezierPath()
            cursor.move(to: CGPoint(x: base.x - scale * 0.20, y: base.y + scale * 0.115))
            cursor.line(to: CGPoint(x: base.x - scale * 0.06, y: base.y))
            cursor.line(to: CGPoint(x: base.x - scale * 0.20, y: base.y - scale * 0.115))
            cursor.move(to: CGPoint(x: base.x + scale * 0.03, y: base.y - scale * 0.105))
            cursor.line(to: CGPoint(x: base.x + scale * 0.22, y: base.y - scale * 0.105))
            cursor.lineWidth = scale * 0.055
            cursor.lineCapStyle = .round
            cursor.lineJoinStyle = .round
            ink.setStroke()
            cursor.stroke()
            return true
        }
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let suffix = density == 1 ? "" : "@2x"
        try bitmap.representation(using: .png, properties: [:])!.write(
            to: directory.appendingPathComponent("icon_\(side)x\(side)\(suffix).png"))
    }
}
