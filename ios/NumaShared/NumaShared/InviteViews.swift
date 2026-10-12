import AuthenticationServices
import SwiftUI

struct JoinPotView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var codeFocused: Bool
    let palette: Pal.Palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                phaseContent
                if let error = app.joinErrorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(palette.ink2)
                        .accessibilityLabel(localizedFormat("Invite error: %@", error))
                }
            }
            .padding(24)
        }
        .foregroundStyle(palette.ink)
        .background(palette.bg)
        .presentationDetents(dynamicTypeSize.isAccessibilitySize
            ? [.large]
            : [.medium, .large])
        .presentationDragIndicator(.hidden)
        .interactiveDismissDisabled(app.joinIsBusy)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(headerTitle)
                    .font(.title2.bold())
                    .accessibilityAddTraits(.isHeader)
                Text(headerDetail)
                    .font(.subheadline)
                    .foregroundStyle(palette.ink2)
            }
            Spacer(minLength: 12)
            if !app.joinIsBusy {
                CloseCircleButton(palette: palette, action: app.dismissJoin)
                    .accessibilityLabel(String(localized: "Close join pot"))
            }
        }
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch app.joinPhase {
        case .entry:
            codeEntry
        case .resolving:
            progress(
                title: String(localized: "Checking invite"),
                detail: String(localized: "No pot history is opened until the invite is accepted.")
            )
        case let .preview(potName, kind):
            preview(potName: potName, kind: kind)
        case let .claiming(potName):
            progress(
                title: localizedFormat("Joining %@", displayName(potName)),
                detail: String(localized: "Your existing records remain on this iPhone.")
            )
        case let .pendingApproval(potName):
            result(
                symbol: "clock",
                title: String(localized: "Waiting for approval"),
                detail: localizedFormat(
                    "%@ will appear after a pot owner approves your request.",
                    displayName(potName)
                ),
                actionTitle: String(localized: "Done"),
                action: app.dismissJoin
            )
        case let .joined(potName):
            result(
                symbol: "checkmark",
                title: String(localized: "Pot joined"),
                detail: localizedFormat(
                    "%@ is ready on this iPhone.",
                    displayName(potName)
                ),
                actionTitle: String(localized: "Open pot"),
                action: app.openJoinedPot
            )
        case let .inactive(status):
            inactive(status)
        }
    }

    private var codeEntry: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(String(localized: "Invite code"))
                .font(.subheadline.weight(.semibold))
            TextField(String(localized: "Six-letter or number code"), text: $app.joinCode)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .textContentType(.oneTimeCode)
                .font(.title3.monospaced())
                .padding(.horizontal, 16)
                .frame(minHeight: 54)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.hair))
                .focused($codeFocused)
                .submitLabel(.continue)
                .onSubmit(app.submitJoinCode)
                .accessibilityIdentifier("Invite code")

            PrimaryPillButton(
                title: String(localized: "Check code"),
                palette: palette,
                action: app.submitJoinCode
            )

            Text(String(localized: "The code is six letters or numbers. Spaces and hyphens are okay."))
                .font(.caption)
                .foregroundStyle(palette.ink3)
        }
    }

    private func preview(potName: String?, kind: InviteKind) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label {
                Text(localizedFormat("Invite to %@", displayName(potName)))
                    .font(.headline)
            } icon: {
                Image(systemName: "person.2")
            }

            Text(previewDetail(kind))
                .font(.subheadline)
                .foregroundStyle(palette.ink2)

            if app.joinNeedsAuthentication {
                Text(String(localized: "This keeps your pots synced and tells friends it’s you."))
                    .font(.subheadline)
                    .foregroundStyle(palette.ink2)

                SignInWithAppleButton(
                    .continue,
                    onRequest: app.prepareAppleAuthorization,
                    onCompletion: app.completeAppleAuthorization
                )
                .signInWithAppleButtonStyle(palette.isDark ? .white : .black)
                .frame(height: 54)
                .clipShape(Capsule())
                .accessibilityIdentifier("Join with Apple")
            } else {
                PrimaryPillButton(
                    title: String(localized: "Join this pot"),
                    palette: palette,
                    action: app.claimResolvedInvite
                )
            }

            Button(String(localized: "Use another code"), action: app.useAnotherJoinCode)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.ink)
                .frame(maxWidth: .infinity, minHeight: 44)
                .buttonStyle(PressableButtonStyle())
        }
    }

    private func progress(title: String, detail: String) -> some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.large)
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(palette.ink2)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .accessibilityElement(children: .combine)
    }

    private func result(
        symbol: String,
        title: String,
        detail: String,
        actionTitle: String,
        action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.title2.weight(.semibold))
                .frame(width: 52, height: 52)
                .background(palette.chip, in: Circle())
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(palette.ink2)
                .multilineTextAlignment(.center)
            PrimaryPillButton(title: actionTitle, palette: palette, action: action)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }

    private func inactive(_ status: InvitePreviewStatus) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(inactiveTitle(status), systemImage: "link.badge.xmark")
                .font(.headline)
            Text(String(localized: "Ask for a new link or enter another code."))
                .font(.subheadline)
                .foregroundStyle(palette.ink2)
            PrimaryPillButton(
                title: String(localized: "Enter another code"),
                palette: palette,
                action: app.useAnotherJoinCode
            )
        }
    }

    private var headerTitle: String {
        switch app.joinPhase {
        case .entry, .resolving, .inactive:
            String(localized: "Join a pot")
        case .preview, .claiming, .pendingApproval, .joined:
            String(localized: "Pot invitation")
        }
    }

    private var headerDetail: String {
        switch app.joinPhase {
        case .entry:
            String(localized: "Open an invite link or enter its short code.")
        case .resolving:
            String(localized: "Checking the invitation without opening its history.")
        case .preview:
            String(localized: "Confirm the pot before joining.")
        case .claiming:
            String(localized: "Confirming your place in this pot.")
        case .pendingApproval:
            String(localized: "This link requires a pot owner’s approval.")
        case .joined:
            String(localized: "The shared history is now available.")
        case .inactive:
            String(localized: "This invitation can’t be used.")
        }
    }

    private func previewDetail(_ kind: InviteKind) -> String {
        switch kind {
        case .perMember:
            String(localized: "This invitation claims the place prepared for you.")
        case .potLink:
            String(localized: "A pot owner must approve this request before any history appears.")
        }
    }

    private func inactiveTitle(_ status: InvitePreviewStatus) -> String {
        switch status {
        case .expired:
            String(localized: "This invitation expired")
        case .revoked:
            String(localized: "This invitation was withdrawn")
        case .used:
            String(localized: "This invitation was already used")
        case .rateLimited:
            String(localized: "Too many checks right now")
        case .invalid, .active:
            String(localized: "This invitation isn’t valid")
        }
    }

    private func displayName(_ potName: String?) -> String {
        potName ?? String(localized: "This pot")
    }
}
