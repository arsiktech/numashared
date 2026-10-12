import Foundation
import NumaSharedCore
import NumaSharedSync
import UIKit
@preconcurrency import UserNotifications

enum PushNotificationPermissionState: Equatable, Sendable {
    case notDetermined
    case denied
    case authorized
}

@MainActor
protocol PushNotificationSystem: AnyObject {
    func authorizationStatus() async -> PushNotificationPermissionState
    func requestAuthorization() async throws -> Bool
    func registerForRemoteNotifications()
}

@MainActor
final class SystemPushNotificationSystem: PushNotificationSystem {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func authorizationStatus() async -> PushNotificationPermissionState {
        let settings = await center.notificationSettings()
        return switch settings.authorizationStatus {
        case .notDetermined:
            .notDetermined
        case .denied:
            .denied
        case .authorized, .provisional, .ephemeral:
            .authorized
        @unknown default:
            .denied
        }
    }

    func requestAuthorization() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .sound])
    }

    func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }
}

// Pure hex mapping — nonisolated like PushNotificationRoute below, so callers
// (and tests) don't inherit this file's main-actor default for value work.
nonisolated extension APNsDeviceToken {
    init?(deviceTokenData: Data) {
        self.init(hex: deviceTokenData.map {
            String(format: "%02x", $0)
        }.joined())
    }
}

nonisolated struct PushNotificationRoute: Equatable, Sendable {
    let potID: PotID

    init?(userInfo: [AnyHashable: Any]) {
        guard userInfo["route"] as? String == "pot",
              let rawPotID = userInfo["potId"] as? String,
              let uuid = UUID(uuidString: rawPotID),
              let potID = try? PotID(validating: uuid)
        else { return nil }
        self.potID = potID
    }
}

@MainActor
final class PushNotificationBridge {
    static let shared = PushNotificationBridge()

    private weak var appModel: AppModel?
    private var pendingToken: APNsDeviceToken?
    private var pendingRoute: PushNotificationRoute?
    private var hasPendingRegistrationFailure = false

    private init() {}

    func connect(to appModel: AppModel) {
        self.appModel = appModel
        if let pendingToken {
            self.pendingToken = nil
            appModel.receivePushDeviceToken(pendingToken)
        }
        if let pendingRoute {
            self.pendingRoute = nil
            appModel.receivePushNotificationRoute(pendingRoute)
        }
        if hasPendingRegistrationFailure {
            hasPendingRegistrationFailure = false
            appModel.receivePushRegistrationFailure()
        }
    }

    func receiveDeviceToken(_ data: Data) {
        guard let token = APNsDeviceToken(deviceTokenData: data) else { return }
        guard let appModel else {
            pendingToken = token
            return
        }
        appModel.receivePushDeviceToken(token)
    }

    func receiveNotification(userInfo: [AnyHashable: Any]) {
        guard let route = PushNotificationRoute(userInfo: userInfo) else { return }
        guard let appModel else {
            pendingRoute = route
            return
        }
        appModel.receivePushNotificationRoute(route)
    }

    func receiveRegistrationFailure() {
        guard let appModel else {
            hasPendingRegistrationFailure = true
            return
        }
        appModel.receivePushRegistrationFailure()
    }
}

@MainActor
final class NumaSharedAppDelegate: NSObject, UIApplicationDelegate,
    UNUserNotificationCenterDelegate
{
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [
            UIApplication.LaunchOptionsKey: Any
        ]? = nil
    ) -> Bool {
        _ = application
        _ = launchOptions
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        _ = application
        PushNotificationBridge.shared.receiveDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        _ = application
        _ = error
        PushNotificationBridge.shared.receiveRegistrationFailure()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        _ = center
        _ = notification
        return [.banner, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        _ = center
        PushNotificationBridge.shared.receiveNotification(
            userInfo: response.notification.request.content.userInfo
        )
    }

    func connect(to appModel: AppModel) {
        PushNotificationBridge.shared.connect(to: appModel)
    }
}
