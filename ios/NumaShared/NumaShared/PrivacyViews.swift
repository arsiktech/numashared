import SwiftUI

private struct AppSwitcherPrivacyModifier: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.overlay {
            if scenePhase != .active {
                AppSwitcherPrivacyShield()
                    .transition(.opacity)
                    .zIndex(10_000)
            }
        }
    }
}

private struct AppSwitcherPrivacyShield: View {
    @Environment(\.colorScheme) private var colorScheme

    private var palette: Pal.Palette {
        colorScheme == .dark ? Pal.dark : Pal.light
    }

    var body: some View {
        ZStack {
            palette.bg
                .ignoresSafeArea()
            VStack(spacing: 8) {
                Text(String(localized: "Numa Shared"))
                    .font(.system(size: 24, weight: .bold))
                Text(String(localized: "Shared expenses, made clear."))
                    .font(.subheadline)
                    .foregroundStyle(palette.ink2)
            }
            .foregroundStyle(palette.ink)
            .accessibilityElement(children: .combine)
        }
        .accessibilityIdentifier("app-switcher-privacy-shield")
    }
}

extension View {
    func obscuresAppSwitcherSnapshot() -> some View {
        modifier(AppSwitcherPrivacyModifier())
    }
}
