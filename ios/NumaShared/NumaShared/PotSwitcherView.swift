import SwiftUI

/// The pot switcher — the create/switch slice of design frame 90 for
/// v1.1 local multi-pot. Rename/archive/leave remain follow-ups; while
/// sync is enabled it stays bound to its pot, so managing is disabled
/// with a calm explanation instead of hidden.
struct PotSwitcherView: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette

    var body: some View {
        VStack(spacing: 0) {
            SheetGrabber(palette: palette)
            HStack {
                Text(String(localized: "Pots"))
                    .font(NumaFont.system(17, weight: .semibold))
                Spacer()
                Text("\(app.localPots.count)")
                    .font(NumaFont.system(13).monospacedDigit())
                    .foregroundStyle(palette.ink2)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 24).padding(.top, 14)

            ScrollView {
                VStack(spacing: 4) {
                    ForEach(app.localPots) { pot in
                        potRow(pot)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 10)
            }

            if !app.canManagePots {
                Text(String(localized: "Sync keeps this pot active in this version."))
                    .font(NumaFont.system(12))
                    .foregroundStyle(palette.ink2)
                    .padding(.top, 8)
            }

            PrimaryPillButton(
                title: String(localized: "New pot"),
                palette: palette
            ) {
                app.beginNewPot()
            }
            .disabled(!app.canManagePots)
            .opacity(app.canManagePots ? 1 : 0.4)
            .padding(.horizontal, 24).padding(.top, 14)
            .accessibilityIdentifier("new-pot")
        }
        .padding(.bottom, 18)
        .foregroundStyle(palette.ink)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(palette.bg)
        .presentationDetents([.medium])
    }

    private func potRow(_ pot: LocalPotDescriptor) -> some View {
        let isActive = pot.id == app.activePotID
        let name = pot.name.isEmpty ? String(localized: "Untitled pot") : pot.name
        return Button {
            app.switchPot(to: pot.id)
        } label: {
            HStack(spacing: 12) {
                Circle()
                    .strokeBorder(
                        isActive ? AnyShapeStyle(Pal.wovenRing) : AnyShapeStyle(palette.hair),
                        lineWidth: 3
                    )
                    .frame(width: 14, height: 14)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(NumaFont.system(15, weight: .semibold))
                    Text(pot.currencyCode)
                        .font(NumaFont.system(11).monospacedDigit())
                        .foregroundStyle(palette.ink2)
                }
                Spacer(minLength: 0)
                if isActive {
                    Text(String(localized: "Active"))
                        .font(NumaFont.system(11, weight: .semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(palette.chip, in: Capsule())
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isActive ? palette.surface : .clear,
                in: RoundedRectangle(cornerRadius: Metrics.radiusM)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(scale: 0.99))
        .disabled(!app.canManagePots && !isActive)
        .accessibilityLabel(isActive
            ? String(localized: "\(name), active pot")
            : String(localized: "Switch to \(name)"))
    }
}
