import SwiftUI

func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

/// Unitless initial velocity for an `interpolatingSpring` return-to-origin:
/// the gesture's predicted momentum projected onto the return direction,
/// normalized by the travel distance (velocity handoff per fluid interfaces).
func springReturnVelocity(current: CGPoint, predicted: CGPoint, origin: CGPoint) -> CGFloat {
    let d = dist(current, origin)
    guard d > 1 else { return 0 }
    let dir = CGPoint(x: (origin.x - current.x) / d, y: (origin.y - current.y) / d)
    let v = CGPoint(x: predicted.x - current.x, y: predicted.y - current.y)
    let proj = (v.x * dir.x + v.y * dir.y) / d
    return max(-3, min(3, proj * 4))
}

/// Orb layout math ported from the source prototype's `mk()` / `homeTargets()`:
/// creditors float above the dashed even line, debtors below; size encodes
/// |balance| capped between 48 and 92pt.
struct ConstellationLayout {
    struct Orb { let unit: UnitID; let point: CGPoint; let size: CGFloat }
    let orbs: [Orb]
    let width: CGFloat
    let height: CGFloat
    let size: CGSize
    let lineY: CGFloat
    let lineInset: CGFloat
    let ringCenter: CGPoint
    let ringDiameter: CGFloat
    let targetsIncludingAll: [String: CGPoint]

    static func make(
        balances: [UnitID: Int64],
        units: [UnitID] = UnitID.allCases,
        empty: Bool,
        allEven: Bool,
        size: CGSize
    ) -> ConstellationLayout {
        let w = size.width, h = size.height
        let sx: (CGFloat) -> CGFloat = { $0 / 393 * w }
        // Tighter vertical map (was 460) so the constellation fills the field
        // without large empty bands above the dock.
        let sy: (CGFloat) -> CGFloat = { $0 / 400 * h }
        let maxMagnitude = max(
            units.map { (balances[$0] ?? 0).magnitude }.max() ?? 0,
            1
        )
        func sizeFor(_ value: Int64) -> CGFloat {
            let maximumGrowth: CGFloat = units.count > 5 ? 18 : 48
            return 52 + maximumGrowth * min(
                1,
                CGFloat(value.magnitude) / CGFloat(maxMagnitude)
            )
        }

        var orbs: [Orb] = []
        var targets: [String: CGPoint] = [:]
        func place(_ u: UnitID, _ x: CGFloat, _ y: CGFloat) {
            let pt = CGPoint(x: sx(x), y: sy(y))
            targets[u.rawValue] = pt
            let s: CGFloat = (empty || allEven) ? 64 : sizeFor(balances[u] ?? 0)
            orbs.append(Orb(unit: u, point: pt, size: s))
        }

        if units.count > 3 {
            let ups = units.filter { (balances[$0] ?? 0) > 0 }
            let downs = units.filter { (balances[$0] ?? 0) <= 0 }

            func placeRows(_ rowUnits: [UnitID], startingAt y: CGFloat) {
                let capacity = 4
                for rowStart in stride(from: 0, to: rowUnits.count, by: capacity) {
                    let row = Array(rowUnits[rowStart..<min(rowStart + capacity, rowUnits.count)])
                    for (index, unit) in row.enumerated() {
                        let x = 393 * CGFloat(index + 1) / CGFloat(row.count + 1)
                        place(unit, x, y + CGFloat(rowStart / capacity) * 110)
                    }
                }
            }

            placeRows(ups, startingAt: 48)
            placeRows(downs, startingAt: ups.count > 4 ? 228 : 188)
        } else if empty || allEven {
            if units.count == 3, allEven {
                place(units[0], 196, 52)
                place(units[1], 96, 248)
                place(units[2], 296, 248)
            } else {
                for (index, unit) in units.enumerated() {
                    let x = 393 * CGFloat(index + 1) / CGFloat(units.count + 1)
                    place(unit, x, 188)
                }
            }
        } else {
            let ups = units.filter { (balances[$0] ?? 0) > 0 }
            let downs = units.filter { (balances[$0] ?? 0) <= 0 }
            for (i, u) in ups.enumerated() {
                // Single creditor sits closer to the even line so the field
                // doesn't leave a lonely orb floating in empty sky.
                let y: CGFloat = ups.count == 1 ? 96 : 88 + CGFloat(i % 2) * 18
                place(u, ups.count == 1 ? 196 : 110 + CGFloat(i) * 176, y)
            }
            for (i, u) in downs.enumerated() {
                let x: CGFloat = downs.count == 1 ? 196 : (downs.count == 2 ? 106 + CGFloat(i) * 182 : 76 + CGFloat(i) * 120)
                place(u, x, 268 + CGFloat(i % 2) * 14)
            }
        }
        targets["all"] = CGPoint(x: sx(196), y: sy(40))

        return ConstellationLayout(orbs: orbs, width: w, height: h, size: size,
                                    lineY: sy(188), lineInset: sx(24),
                                    ringCenter: CGPoint(x: sx(196), y: sy(188)), ringDiameter: sx(236),
                                    targetsIncludingAll: targets)
    }
}
