import SwiftUI

/// Approved interface-v2 vectors, kept native and resolution-independent.
/// Stroke geometry is the board's 24-unit coordinate system, not an SF substitute.
struct HomeIcon: View {
    nonisolated enum Kind: Sendable {
        case gear, arrow, plus, dinner, wifi, home, history, people
        case back, chevron, lock, info, search, check, edit, close, swap, delete
    }
    let kind: Kind
    var size: CGFloat = 22
    var body: some View {
        HomeIconPath(kind: kind)
            .stroke(style: StrokeStyle(lineWidth: size / 24 * (kind == .plus ? 1.65 : 1.7), lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private nonisolated struct HomeIconPath: Shape {
    let kind: HomeIcon.Kind
    func path(in rect: CGRect) -> Path {
        var p = Path()
        func move(_ x: CGFloat, _ y: CGFloat) { p.move(to: CGPoint(x: x, y: y)) }
        func line(_ x: CGFloat, _ y: CGFloat) { p.addLine(to: CGPoint(x: x, y: y)) }
        func circle(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat) {
            p.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
        }
        // SVG circular-arc conversion. All approved arcs here have rx == ry.
        func arc(to end: CGPoint, radius: CGFloat, large: Bool = false, sweep: Bool = false) {
            guard let start = p.currentPoint else { return }
            let dx = (start.x - end.x) / 2, dy = (start.y - end.y) / 2
            let squared = dx * dx + dy * dy
            let factor = (large == sweep ? -1.0 : 1.0) * sqrt(max(0, (radius * radius - squared) / squared))
            let center = CGPoint(x: (start.x + end.x) / 2 + factor * dy,
                                 y: (start.y + end.y) / 2 - factor * dx)
            p.addArc(center: center, radius: radius,
                     startAngle: .radians(atan2(start.y - center.y, start.x - center.x)),
                     endAngle: .radians(atan2(end.y - center.y, end.x - center.x)), clockwise: !sweep)
        }
        switch kind {
        case .gear:
            move(9, 3); line(15, 3); line(16, 6); line(19, 7); line(21, 12); line(19, 17)
            line(16, 18); line(15, 21); line(9, 21); line(8, 18); line(5, 17); line(3, 12); line(5, 7); line(8, 6); p.closeSubpath()
            circle(12, 12, 3)
        case .arrow:
            move(5, 12); line(19, 12); move(13, 6); line(19, 12); line(13, 18)
        case .back:
            move(14, 6); line(8, 12); line(14, 18)
        case .chevron:
            move(9, 6); line(15, 12); line(9, 18)
        case .lock:
            move(6, 10); line(18, 10); line(18, 21); line(6, 21); p.closeSubpath()
            move(8, 10); line(8, 7); arc(to: CGPoint(x: 16, y: 7), radius: 4, sweep: true); line(16, 10)
        case .info:
            circle(12, 12, 9)
            move(12, 11); line(12, 17); move(12, 7); line(12, 7.01)
        case .search:
            circle(10, 10, 7)
            move(16, 16); line(21, 21)
        case .check:
            move(5, 12); line(9, 16); line(19, 6)
        case .edit:
            move(14, 5); line(19, 10)
            move(4, 20); line(9, 19); line(21, 7); line(16, 2); line(4, 14); p.closeSubpath()
        case .close:
            move(6, 6); line(18, 18); move(6, 18); line(18, 6)
        case .swap:
            move(4, 8); line(20, 8); move(16, 4); line(20, 8); line(16, 12)
            move(20, 16); line(4, 16); move(8, 12); line(4, 16); line(8, 20)
        case .delete:
            move(8, 5); line(2, 12); line(8, 19); line(21, 19); line(21, 5); p.closeSubpath()
            move(11, 9); line(17, 15); move(17, 9); line(11, 15)
        case .plus:
            move(12, 5); line(12, 19); move(5, 12); line(19, 12)
        case .dinner:
            move(4, 3); line(4, 9); arc(to: CGPoint(x: 8, y: 9), radius: 2); line(8, 3)
            move(6, 3); line(6, 21); move(16, 3); line(16, 21); move(16, 3)
            p.addCurve(to: CGPoint(x: 16, y: 13), control1: CGPoint(x: 12, y: 7), control2: CGPoint(x: 12, y: 13))
        case .wifi:
            move(3, 8); arc(to: CGPoint(x: 21, y: 8), radius: 15, sweep: true)
            move(6, 12); arc(to: CGPoint(x: 18, y: 12), radius: 10, sweep: true)
            move(9, 16); arc(to: CGPoint(x: 15, y: 16), radius: 5, sweep: true)
            move(12, 20); line(12.01, 20)
        case .home:
            move(3, 10); line(12, 3); line(21, 10); line(21, 20); line(3, 20); p.closeSubpath()
            move(9, 20); line(9, 13); line(15, 13); line(15, 20)
        case .history:
            move(4, 5); line(4, 10); line(9, 10)
            move(4, 10); arc(to: CGPoint(x: 4, y: 15), radius: 8, large: true, sweep: true)
            move(12, 7); line(12, 12); line(15, 14)
        case .people:
            move(16, 21); line(16, 18); arc(to: CGPoint(x: 12, y: 14), radius: 4)
            line(6, 14); arc(to: CGPoint(x: 2, y: 18), radius: 4); line(2, 21)
            move(16, 4); arc(to: CGPoint(x: 16, y: 12), radius: 4, sweep: true)
            move(22, 21); line(22, 18); arc(to: CGPoint(x: 19, y: 14.1), radius: 4)
            circle(9, 6, 4)
        }
        return p.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24))
    }
}
