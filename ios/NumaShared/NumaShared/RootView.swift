import SwiftUI

struct RootView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    private var palette: Pal.Palette { colorScheme == .dark ? Pal.dark : Pal.light }

    var body: some View {
        Group {
            if app.hasBlockingLocalDataFailure {
                LocalDataRecoveryView(
                    palette: palette,
                    message: app.localDataErrorMessage ?? "",
                    isRetrying: app.isRecoveringLocalData,
                    retry: app.retryLocalData
                )
            } else if app.isBootstrapping {
                LoadingHomeSkeleton(palette: palette)
            } else if app.requiresAppUpdate {
                RequiredAppUpdateView(palette: palette)
            } else {
                switch app.screen {
                case .welcome: WelcomeView(palette: palette)
                case .create: CreatePotView(palette: palette)
                case .people: AddPeopleView(palette: palette)
                case .openingBalance: OpeningBalanceView(palette: palette)
                case .home: HomeView(palette: palette)
                }
            }
        }
        .saturation(app.isCurrentMemberArchived ? 0 : 1)
        .fullScreenCover(isPresented: $app.addPresented) {
            // A system cover keeps entry independent from the scrollable Add
            // row's geometry and provides the same transition for every tap.
            AddExpenseView(palette: palette)
                .obscuresAppSwitcherSnapshot()
        }
        .sheet(isPresented: Binding(
            get: { app.sheet != .none },
            set: { if !$0 { app.closeSheet() } }
        )) {
            SheetContainerView(palette: palette)
                .obscuresAppSwitcherSnapshot()
        }
        .sheet(
            isPresented: $app.syncSetupPresented,
            onDismiss: app.syncSetupDidDismiss
        ) {
            SyncSetupView(palette: palette)
                .obscuresAppSwitcherSnapshot()
        }
        .sheet(isPresented: $app.joinPresented, onDismiss: app.joinDidDismiss) {
            JoinPotView(palette: palette)
                .obscuresAppSwitcherSnapshot()
        }
        .sheet(isPresented: $app.peoplePresented) {
            PeopleManagementView(palette: palette)
                .obscuresAppSwitcherSnapshot()
        }
        .sheet(isPresented: $app.potSwitcherPresented) {
            PotSwitcherView(palette: palette)
                .obscuresAppSwitcherSnapshot()
        }
        .sheet(isPresented: $app.settingsPresented) {
            SettingsView(palette: palette)
                .obscuresAppSwitcherSnapshot()
        }
        .onOpenURL { _ = app.handleOpenURL($0) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { app.refreshAppConfiguration() }
        }
        .preferredColorScheme(nil)
#if DEBUG
        .statusBarHidden(app.qaHidesStatusBar)
#endif
        .tint(palette.ink)
        .obscuresAppSwitcherSnapshot()
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                if app.isCurrentMemberArchived {
                    Text(String(localized: "You’re no longer a member. This frozen copy stays available to review and export."))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(palette.ink)
                        .accessibilityIdentifier("frozen-pot-banner")
                        .accessibilityAddTraits(.isHeader)
                } else if app.requiresUpdate && !app.requiresAppUpdate {
                    Text(String(localized: "Please update"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(palette.ink)
                        .accessibilityAddTraits(.isHeader)
                }
                if !app.hasBlockingLocalDataFailure,
                   let message = app.localDataErrorMessage {
                    LocalDataRetryBanner(
                        palette: palette,
                        message: message,
                        isRetrying: app.isRecoveringLocalData,
                        retry: app.retryLocalData
                    )
                }
            }
        }
    }
}

private struct LocalDataRecoveryView: View {
    let palette: Pal.Palette
    let message: String
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "arrow.clockwise.circle")
                .font(.system(size: 44, weight: .semibold))
                .accessibilityHidden(true)
            Text(String(localized: "Your pot couldn’t be opened"))
                .font(.title.bold())
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(.body)
                .foregroundStyle(palette.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: retry) {
                Group {
                    if isRetrying {
                        ProgressView()
                            .tint(palette.bg)
                    } else {
                        Text(String(localized: "Retry"))
                            .font(.body.weight(.semibold))
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(PressableButtonStyle())
            .foregroundStyle(palette.bg)
            .background(palette.ink, in: Capsule())
            .disabled(isRetrying)
            .accessibilityIdentifier("local-data-retry")
            .accessibilityLabel(String(localized: isRetrying ? "Retrying" : "Retry"))
        }
        .padding(28)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.bg)
    }
}

private struct LocalDataRetryBanner: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let palette: Pal.Palette
    let message: String
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    messageText
                    retryButton.frame(maxWidth: .infinity)
                }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    messageText
                    Spacer(minLength: 4)
                    retryButton
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(palette.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(palette.hair).frame(height: 1)
        }
    }

    private var messageText: some View {
        Text(message)
            .font(.footnote.weight(.medium))
            .foregroundStyle(palette.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var retryButton: some View {
        Button(action: retry) {
            Group {
                if isRetrying {
                    ProgressView()
                } else {
                    Text(String(localized: "Retry"))
                        .font(.subheadline.weight(.semibold))
                }
            }
            .frame(minWidth: 64, minHeight: 44)
        }
        .buttonStyle(PressableButtonStyle())
        .foregroundStyle(palette.ink)
        .background(palette.chip, in: Capsule())
        .disabled(isRetrying)
        .accessibilityIdentifier("local-data-banner-retry")
        .accessibilityLabel(String(localized: isRetrying ? "Retrying" : "Retry"))
    }
}

private struct LoadingHomeSkeleton: View {
    let palette: Pal.Palette

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Capsule().fill(palette.chip).frame(width: 118, height: 38)
                Spacer()
                Circle().fill(palette.chip).frame(width: 42, height: 42)
                Circle().fill(palette.chip).frame(width: 42, height: 42)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)

            VStack(alignment: .leading, spacing: 10) {
                Capsule().fill(palette.chip).frame(width: 132, height: 14)
                RoundedRectangle(cornerRadius: 12)
                    .fill(palette.chip)
                    .frame(width: 230, height: 44)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 28)

            ZStack {
                Capsule().fill(palette.hair).frame(width: 290, height: 2)
                Circle().fill(palette.chip).frame(width: 72, height: 72)
                    .offset(x: -94, y: 45)
                Circle().fill(palette.chip).frame(width: 82, height: 82)
                    .offset(y: -50)
                Circle().fill(palette.chip).frame(width: 64, height: 64)
                    .offset(x: 102, y: 35)
            }
            .frame(maxHeight: .infinity)

            RoundedRectangle(cornerRadius: Metrics.sheetRadius)
                .fill(palette.surface)
                .frame(height: 118)
                .overlay(alignment: .topLeading) {
                    VStack(alignment: .leading, spacing: 12) {
                        Capsule().fill(palette.chip).frame(width: 92, height: 13)
                        Capsule().fill(palette.chip).frame(height: 16)
                    }
                    .padding(22)
                }
        }
        .background(palette.bg)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "Loading your pot"))
        .accessibilityIdentifier("loading-home-skeleton")
    }
}

private struct RequiredAppUpdateView: View {
    let palette: Pal.Palette

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "arrow.down.app.fill")
                .font(.system(size: 44, weight: .semibold))
                .accessibilityHidden(true)
            Text(String(localized: "Please update Numa Shared"))
                .font(.title.bold())
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(String(
                localized: "This version can no longer sync shared pots safely. Install the latest version from the App Store to continue."
            ))
            .font(.body)
            .foregroundStyle(palette.ink2)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)

            if let url = Self.appStoreURL() {
                Link(destination: url) {
                    Text(String(localized: "Open the App Store"))
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(PressableButtonStyle())
                .foregroundStyle(palette.bg)
                .background(palette.ink, in: Capsule())
                .accessibilityHint(String(localized: "Opens the Numa Shared App Store page."))
            }
        }
        .foregroundStyle(palette.ink)
        .padding(28)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.bg)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("required-app-update")
    }

    nonisolated private static func appStoreURL(_ bundle: Bundle = .main) -> URL? {
        guard let value = bundle.object(
            forInfoDictionaryKey: "NumaSharedAppStoreURL"
        ) as? String,
              let url = URL(string: value),
              url.scheme == "https"
        else { return nil }
        return url
    }
}
