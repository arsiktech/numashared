import Foundation
import XCTest
@testable import NumaSharedCore

/// The backend keeps Swift build 11's text contract until build 11 is fenced out
/// (convex/lib/clientContract.ts). convex/wireContract.test.ts proves the backend accepts exactly
/// the manifests in build-11-reader-contract.json; this proves the Swift reader reads all of them.
final class Build11ReaderContractTests: XCTestCase {
    private struct Contract: Decodable {
        let maximumBudgetGroupSize: Int
        let allowedTextFields: [String: [String]]
    }

    func testReaderAcceptsEveryManifestTheBackendAcceptsByDefault() throws {
        let contractURL = try XCTUnwrap(
            Bundle.module.url(forResource: "build-11-reader-contract", withExtension: "json")
        )
        let contract = try JSONDecoder().decode(Contract.self, from: Data(contentsOf: contractURL))
        let eventsURL = try XCTUnwrap(
            Bundle.module.url(forResource: "wire-events-v1", withExtension: "json")
        )
        let events = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: eventsURL)) as? [[String: Any]]
        )
        var seen = Set<String>()
        for source in events {
            let payload = try XCTUnwrap(source["payload"] as? [String: Any])
            let kind = try XCTUnwrap(payload["kind"] as? String)
            let contentKind = (payload["content"] as? [String: Any])?["kind"] as? String
            let key = kind == "expenseRevised" ? "expenseRevised.\(contentKind ?? "")" : kind
            let fields = try XCTUnwrap(contract.allowedTextFields[key], "No contract for \(key)")
            seen.insert(key)

            // The fullest manifest the backend accepts for this kind.
            var widest = source
            widest["textFields"] = fields
            widest["authoredText"] = fields.map { ["field": $0, "value": "Synthetic text"] }
            let data = try JSONSerialization.data(withJSONObject: widest)
            let decoded: WireEventV1
            do {
                decoded = try JSONDecoder().decode(WireEventV1.self, from: data)
            } catch {
                XCTFail("Build 11 can't read \(key) with \(fields): \(error)")
                continue
            }
            XCTAssertEqual(decoded.payload.textContract.allowed.map(\.rawValue), fields, key)
        }
        XCTAssertEqual(seen, Set(contract.allowedTextFields.keys))
    }
}
