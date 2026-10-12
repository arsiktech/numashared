import SwiftUI
import UIKit
import XCTest
@testable import NumaShared

final class ActivityRowLayoutTests: XCTestCase {
    /// Exercise supported money magnitude directly, without creating an app QA
    /// seam or depending on expense-entry validation to reach the rendering edge.
    @MainActor
    func testLongActivityTextAndMaximumAmountStayInsideNarrowRows() async throws {
        let title = "Groceries for Samantha Alexandra and Josephine Gabriella's shared household"
        let payer = "Alexandria Elizabeth Josephine Gabriella"
        let amount = "€92,233,720,368,547,758.07"
        let record = ExpenseRecord(
            id: "layout-record", sortOrdinal: 0, kind: .expense, title: title,
            amountCents: Int64.max, payer: .am, parts: [.am: Int64.max], to: nil,
            occurredAt: Date(timeIntervalSince1970: 1_700_000_000),
            originatingTimeZoneIdentifier: "UTC", category: nil,
            recordedBy: "Samantha Alexandra", voided: false, flagged: false,
            payerDisplayName: payer
        )
        for size in [DynamicTypeSize.large, .accessibility5] {
            let row = ActivityRowView(record: record, palette: Pal.light, amountText: amount)
                .environment(\.dynamicTypeSize, size)
                .frame(width: 320, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            // Measuring an unattached hosting controller does not mount its
            // UIViewRepresentable labels. Give the fixture a real scene/window
            // and a 320pt child viewport before inspecting rendered geometry.
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            let container = UIViewController()
            window.rootViewController = container
            window.isHidden = false
            defer {
                window.isHidden = true
                window.rootViewController = nil
            }
            let controller = UIHostingController(rootView: row)
            controller.traitOverrides.preferredContentSizeCategory =
                size.isAccessibilitySize ? .accessibilityExtraExtraExtraLarge : .large
            container.addChild(controller)
            container.view.addSubview(controller.view)
            controller.view.frame = CGRect(x: 0, y: 0, width: 320, height: 2_000)
            controller.didMove(toParent: container)

            func labels(in view: UIView) -> [UILabel] {
                (view as? UILabel).map { [$0] } ?? view.subviews.flatMap(labels)
            }
            let expectedText = [title, "Paid by \(payer)", amount]
            for _ in 0..<100 {
                controller.view.setNeedsLayout()
                controller.view.layoutIfNeeded()
                let present = Set(labels(in: controller.view).compactMap(\.text))
                if expectedText.allSatisfy(present.contains) { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            let fitting = controller.sizeThatFits(in: CGSize(width: 320, height: 2_000))
            controller.view.frame = CGRect(origin: .zero, size: fitting)
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            let rendered = labels(in: controller.view)
            let geometry = rendered.map { label in
                "\(label.text ?? "<nil>"): frame=\(label.convert(label.bounds, to: controller.view)) font=\(label.font.pointSize)"
            }.joined(separator: "\n")
            let attachment = XCTAttachment(string: "DynamicType=\(size), fitting=\(fitting)\n" + geometry)
            attachment.name = "activity-row-layout-\(size)"
            attachment.lifetime = .keepAlways
            add(attachment)
            for expected in [title, "Paid by \(payer)", amount] {
                let label = try XCTUnwrap(rendered.first { $0.text == expected },
                                          "Missing rendered label: \(expected). \(geometry)")
                let frame = label.convert(label.bounds, to: controller.view)
                XCTAssertGreaterThanOrEqual(frame.minX, -1, expected)
                XCTAssertLessThanOrEqual(frame.maxX, 321, expected)
                let required = label.sizeThatFits(CGSize(width: label.bounds.width, height: .greatestFiniteMagnitude))
                XCTAssertGreaterThanOrEqual(label.bounds.height + 1, required.height, expected)
                XCTAssertEqual(label.numberOfLines, 0, "No truncation of \(expected)")
                XCTAssertFalse(label.adjustsFontSizeToFitWidth, "Do not shrink away accessibility")
                if size.isAccessibilitySize {
                    XCTAssertGreaterThan(label.font.pointSize, 17, "The fixture must exercise scaled text")
                }
            }
            XCTAssertEqual(fitting.width, 320, accuracy: 1)
        }
    }
}
