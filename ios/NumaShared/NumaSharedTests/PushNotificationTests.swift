import Foundation
import NumaSharedCore
import NumaSharedSync
import XCTest
@testable import NumaShared

final class PushNotificationTests: XCTestCase {
    func testDeviceTokenUsesCanonicalHexAndPayloadRoutesOnlyTypedPot() throws {
        let bytes = Data((0 ..< 32).map(UInt8.init))
        let token = try XCTUnwrap(APNsDeviceToken(deviceTokenData: bytes))
        XCTAssertEqual(
            token.hex,
            "000102030405060708090a0b0c0d0e0f"
                + "101112131415161718191a1b1c1d1e1f"
        )

        let potID = PotID.generate(
            at: Date(timeIntervalSince1970: 1_700_000_000)
        )
        XCTAssertEqual(
            PushNotificationRoute(userInfo: [
                "route": "pot",
                "potId": potID.description,
            ])?.potID,
            potID
        )
        XCTAssertNil(PushNotificationRoute(userInfo: [
            "route": "person",
            "potId": potID.description,
        ]))
        XCTAssertNil(PushNotificationRoute(userInfo: [
            "route": "pot",
            "potId": "550e8400-e29b-41d4-a716-446655440000",
        ]))
    }
}
