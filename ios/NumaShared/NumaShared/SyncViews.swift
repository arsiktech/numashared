import AuthenticationServices
import SwiftUI

struct SyncStatusCapsuleView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let palette: Pal.Palette
    @State private var showsRecoveredState = true

    var body: some View {
        Group {
            if !app.syncPresentation.dismissesAutomatically || showsRecoveredState {
                Group {
                    if isActionable {
                        Button(action: action) { content }
                            .buttonStyle(PressableButtonStyle())
                    } else {
                        content
                    }
                }
                .transition(.opacity)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(accessibilityHint)
        .task(id: app.syncPresentation) {
            showsRecoveredState = true
            guard app.syncPresentation.dismissesAutomatically else { return }
            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return
            }
            withAnimation(.easeOut(duration: 0.2)) {
                showsRecoveredState = false
            }
        }
    }

    /// Local-only renders as a quiet cloud chip matching the header's icon
    /// buttons — a setup entry point, not a status shout. Every live sync
    /// state keeps the readable text capsule, and accessibility sizes
    /// always get text.
    private var quietLocal: Bool {
        app.syncPresentation == .local && !dynamicTypeSize.isAccessibilitySize
    }

    private var content: some View {
        Group {
            if quietLocal {
                Image(systemName: symbol)
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .foregroundStyle(palette.ink)
                    .background(palette.chip, in: Circle())
            } else {
                capsuleContent
            }
        }
    }

    private var capsuleContent: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    Label(app.syncPresentation.title, systemImage: symbol)
                        .font(.caption.weight(.semibold))
                    if let detail = app.syncPresentation.detail {
                        Text(detail)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(palette.ink)
                    }
                    if let actionTitle = app.syncPresentation.actionTitle {
                        Text(actionTitle)
                            .font(.caption.weight(.semibold))
                            .underline()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 7) {
                    Image(systemName: symbol)
                        .font(.caption2.weight(.semibold))
                    VStack(alignment: .leading, spacing: 0) {
                        Text(app.syncPresentation.title)
                            .font(.caption2.weight(.semibold))
                        if let detail = app.syncPresentation.detail {
                            Text(detail)
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(palette.ink)
                        }
                    }
                    if let actionTitle = app.syncPresentation.actionTitle {
                        Text("·")
                            .foregroundStyle(palette.ink)
                            .accessibilityHidden(true)
                        Text(actionTitle)
                            .font(.caption2.weight(.semibold))
                            .underline()
                    }
                }
            }
        }
        .foregroundStyle(palette.ink)
        .padding(.horizontal, 12)
        .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
        .frame(minHeight: 44)
        .fixedSize(horizontal: false, vertical: true)
        .background(palette.chip, in: Capsule())
        .overlay(Capsule().stroke(palette.hair))
    }

    private var isActionable: Bool {
        app.syncPresentation.action != .none
    }

    private func action() {
        switch app.syncPresentation.action {
        case .enableSync, .signIn:
            app.beginSyncSetup()
        case .retry:
            app.retrySync()
        case .none:
            break
        }
    }

    private var symbol: String {
        switch app.syncPresentation {
        case .local: "icloud"
        case .signingIn, .syncing: "arrow.triangle.2.circlepath"
        case .offline: "wifi.slash"
        case .paused:
            switch app.syncPresentation.pauseDisposition {
            case .updateRequired: "arrow.down.circle"
            case .signInRequired: "person.crop.circle.badge.exclamationmark"
            case .configurationInvalid: "wrench.and.screwdriver"
            case .accessRemoved: "person.crop.circle.badge.minus"
            case .terminal, .none: "exclamationmark.circle"
            }
        case .synced: "checkmark"
        }
    }

    private var accessibilityLabel: String {
        [app.syncPresentation.title, app.syncPresentation.detail]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    private var accessibilityHint: String {
        switch app.syncPresentation.action {
        case .enableSync:
            String(localized: "Double-tap to keep this pot synced with Sign in with Apple.")
        case .signIn:
            String(localized: "Double-tap to sign in. Your records remain on this iPhone.")
        case .retry:
            String(localized: "Double-tap to retry syncing. Your records remain on this iPhone.")
        case .none:
            localizedFormat("Sync status for %@.", app.potName)
        }
    }
}

struct SyncSetupView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let palette: Pal.Palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(localizedFormat("Keep %@ synced", app.potName))
                            .font(.title2.bold())
                        Text(String(localized: "This keeps your pots synced and tells friends it’s you."))
                            .font(.subheadline)
                            .foregroundStyle(palette.ink2)
                    }
                    Spacer(minLength: 12)
                    CloseCircleButton(palette: palette) {
                        app.dismissSyncSetup()
                    }
                }

                SignInWithAppleButton(
                    .continue,
                    onRequest: app.prepareAppleAuthorization,
                    onCompletion: app.completeAppleAuthorization
                )
                .signInWithAppleButtonStyle(palette.isDark ? .white : .black)
                .frame(height: 54)
                .clipShape(Capsule())
                .accessibilityIdentifier("Sign in with Apple")

                if let error = app.syncErrorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(palette.ink2)
                        .accessibilityLabel(
                            localizedFormat("Sync error: %@", error)
                        )
                }

                Button(String(localized: "Not now")) {
                    app.dismissSyncSetup()
                }
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.ink)
                .frame(maxWidth: .infinity, minHeight: 44)
                .buttonStyle(PressableButtonStyle())

                Text(String(localized: "Canceling leaves every record on this iPhone."))
                    .font(.caption)
                    .foregroundStyle(palette.ink3)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(24)
        }
        .foregroundStyle(palette.ink)
        .background(palette.bg)
        .presentationDetents(dynamicTypeSize.isAccessibilitySize
            ? [.large]
            : [.medium, .large])
        .presentationDragIndicator(.hidden)
    }
}
