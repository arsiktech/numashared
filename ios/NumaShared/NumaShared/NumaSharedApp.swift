import SwiftUI

@main
struct NumaSharedApp: App {
    @UIApplicationDelegateAdaptor(NumaSharedAppDelegate.self)
    private var appDelegate
    @StateObject private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .task { appDelegate.connect(to: app) }
        }
    }
}
