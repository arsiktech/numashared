import CoreImage.CIFilterBuiltins
import NumaSharedCore
import NumaSharedSync
import SwiftUI
import UIKit

struct PeopleManagementView: View {
    @EnvironmentObject private var app: AppModel
    let palette: Pal.Palette

    @State private var claimSelections: [
        PendingInviteClaimID: NumaSharedCore.MemberID
    ] = [:]
    @State private var confirmation: PeopleConfirmation?

    var body: some View {
        NavigationStack {
            List {
                if !app.isSyncEnabled {
                    Section {
                        Text(String(localized: "Enable sync to invite people and manage roles."))
                            .font(.subheadline)
                            .foregroundStyle(palette.ink2)
                    }
                }

                if let invite = app.issuedInvite {
                    issuedInviteSection(invite)
                }

                if app.isIssuingInvite {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text(String(localized: "Creating invite"))
                                .foregroundStyle(palette.ink2)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }

                if app.isSyncEnabled,
                   app.isCurrentMemberOwner,
                   !app.pendingInviteClaims.isEmpty {
                    pendingClaimsSection
                }

                rosterSection
                if app.usesBudgetGroups { budgetGroupsSection }

                if app.isSyncEnabled {
                    notificationsSection
                }

                if app.isSyncEnabled,
                   app.currentMemberProfile?.state == .active {
                    leavePotSection
                }

                if !app.isSyncEnabled || app.isCurrentMemberOwner {
                    inviteControlsSection
                }

                if app.isCurrentMemberOwner, !app.managedInvites.isEmpty {
                    managedInvitesSection
                }

                if app.isRefreshingPeople {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text(String(localized: "Refreshing people"))
                                .foregroundStyle(palette.ink2)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }

                if let error = app.peopleErrorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.subheadline)
                            .foregroundStyle(palette.ink2)
                        Button(String(localized: "Retry"), action: app.refreshPeople)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.ink)
                            .frame(minHeight: 44)
                            .buttonStyle(PressableButtonStyle())
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.bg)
            .foregroundStyle(palette.ink)
            .navigationTitle(String(localized: "People"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Done"), action: app.dismissPeopleManagement)
                        .disabled(app.isUpdatingPeople || app.isIssuingInvite)
                }
                if app.isSyncEnabled {
                    ToolbarItem(placement: .primaryAction) {
                        Button(action: app.refreshPeople) {
                            Image(systemName: "arrow.clockwise")
                                .frame(
                                    width: Metrics.minTarget,
                                    height: Metrics.minTarget
                                )
                        }
                        .disabled(
                            app.isRefreshingPeople
                                || app.isUpdatingPeople
                                || app.isIssuingInvite
                        )
                        .accessibilityLabel(String(localized: "Refresh people"))
                    }
                }
            }
            .confirmationDialog(
                confirmation?.title ?? "",
                isPresented: Binding(
                    get: { confirmation != nil },
                    set: { if !$0 { confirmation = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let confirmation {
                    Button(confirmation.buttonTitle, role: confirmation.role) {
                        apply(confirmation)
                        self.confirmation = nil
                    }
                }
                Button(String(localized: "Cancel"), role: .cancel) {
                    confirmation = nil
                }
            } message: {
                if let confirmation {
                    Text(confirmation.message)
                }
            }
        }
        .interactiveDismissDisabled(app.isUpdatingPeople || app.isIssuingInvite)
    }

    private var rosterSection: some View {
        Section {
            if app.isSyncEnabled || app.usesBudgetGroups {
                if app.memberProfiles.isEmpty {
                    Text(String(localized: "People appear after sync finishes."))
                        .font(.subheadline)
                        .foregroundStyle(palette.ink2)
                } else {
                    ForEach(app.memberProfiles, id: \.memberID) { profile in
                        syncedPersonRow(profile)
                    }
                }
            } else {
                localPersonRow(
                    unitID: .am,
                    name: localName(app.ownerDisplayName, fallback: "Arseny"),
                    role: String(localized: "Owner")
                )
                if app.ledgerUnitIDs.contains(.sam) {
                    localPersonRow(
                        unitID: .sam,
                        name: app.unitInfo(for: .sam).name,
                        role: String(localized: "Pending"),
                        inviteAction: { app.beginInvite(for: .sam) }
                    )
                }
                if app.ledgerUnitIDs.contains(.leo) {
                    localPersonRow(
                        unitID: .leo,
                        name: app.unitInfo(for: .leo).name,
                        role: String(localized: "Pending"),
                        inviteAction: { app.beginInvite(for: .leo) }
                    )
                }
            }
        } header: {
            Text(String(localized: "People"))
        } footer: {
            if app.isSyncEnabled, !app.isCurrentMemberOwner {
                Text(String(localized: "Only the owner can approve requests or change roles."))
            }
        }
    }

    private var budgetGroupsSection: some View {
        Section {
            ForEach(app.memberProfiles.filter { $0.state != .archived }, id: \.memberID) { person in
                VStack(alignment: .leading, spacing: 4) {
                    Text(app.personName(person)).font(.body.weight(.semibold))
                    Text(person.budgetUnitID.map { app.unitInfo(for: $0).name } ?? "No group")
                        .font(.subheadline)
                    if app.canEditBudgetGroups {
                        Menu("Change budget group") {
                            Button("Keep separate") { app.setBudgetPartner(person.memberID, partner: nil) }
                            ForEach(app.memberProfiles.filter { candidate in
                                candidate.memberID != person.memberID && candidate.state != .archived
                                    && !((app.budgetGroupStructure?.groups ?? []).contains { group in
                                        group.orderedMemberIDs.contains(candidate.memberID)
                                    })
                            }, id: \.memberID) { partner in
                                Button("Couple with \(app.personName(partner))") {
                                    app.setBudgetPartner(person.memberID, partner: partner.memberID)
                                }
                            }
                        }
                        .frame(minHeight: 44)
                        .accessibilityLabel("Change budget group for \(app.personName(person))")
                    }
                }
            }
        } header: { Text("Budget groups") }
        footer: {
            Text(app.budgetGroupStructure?.hasFinancialHistory == true
                 ? "Groups are fixed after the first expense, opening balance or repayment, even if voided. Leaving never redistributes debt."
                 : "One person or one couple per group. Couple membership does not grant account access. Set groups before recording money.")
        }
    }

    private var pendingClaimsSection: some View {
        Section {
            ForEach(app.pendingInviteClaims, id: \.id) { claim in
                pendingClaimRow(claim)
            }
        } header: {
            Text(String(localized: "Join requests"))
        } footer: {
            Text(String(localized: "Approval gives this account access to the selected identity and shared history."))
        }
    }

    private var notificationsSection: some View {
        Section {
            Toggle(
                String(localized: "Mute this pot"),
                isOn: Binding(
                    get: { app.isPotMuted },
                    set: { app.setPotMuted($0) }
                )
            )
            .disabled(app.isUpdatingNotifications)

            NotificationPermissionControl(palette: palette)

            if app.isUpdatingNotifications {
                HStack(spacing: 12) {
                    ProgressView()
                    Text(String(localized: "Updating notifications"))
                        .foregroundStyle(palette.ink2)
                }
                .accessibilityElement(children: .combine)
            }

            if let error = app.notificationErrorMessage {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.subheadline)
                    .foregroundStyle(palette.ink2)
            }
        } header: {
            Text(String(localized: "Notifications"))
        } footer: {
            Text(String(localized: "Numa Shared alerts you only when someone else changes your position or a contested record needs your choice. Pushes never include amounts."))
        }
    }

    private var leavePotSection: some View {
        Section {
            Button(String(localized: "Leave pot"), role: .destructive) {
                confirmation = .leave(app.leavePotWarning)
            }
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .buttonStyle(PressableButtonStyle())
            .disabled(!app.canLeaveCurrentPot || app.isUpdatingPeople)
            .accessibilityHint(app.leavePotWarning)
        } footer: {
            if app.canLeaveCurrentPot {
                Text(String(localized: "Leaving never moves money or removes shared history."))
            } else {
                Text(String(localized: "Add or approve another member before leaving this pot."))
            }
        }
    }

    private func localPersonRow(
        unitID: UnitID,
        name: String,
        role: String,
        inviteAction: (() -> Void)? = nil
    ) -> some View {
        HStack(spacing: 13) {
            personAvatar(name: name, unitID: unitID)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(.body.weight(.semibold))
                Text(role)
                    .font(.caption)
                    .foregroundStyle(palette.ink3)
            }
            Spacer(minLength: 8)
            if let inviteAction {
                Button(localizedFormat("Invite %@", name), action: inviteAction)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.ink)
                    .frame(minHeight: 44)
                    .buttonStyle(PressableButtonStyle())
                    .disabled(app.isIssuingInvite)
            }
        }
        .padding(.vertical, 4)
    }

    private func syncedPersonRow(_ profile: AppMemberProfile) -> some View {
        let name = profile.displayName ?? String(localized: "Unknown member")
        return HStack(spacing: 13) {
            personAvatar(name: name, unitID: profile.unitID)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(.body.weight(.semibold))
                Text(profileSubtitle(profile))
                    .font(.caption)
                    .foregroundStyle(palette.ink3)
            }
            Spacer(minLength: 8)
            if !app.isSyncEnabled, profile.role != .owner, profile.state != .archived {
                Button("Invite") { app.beginInvite(for: profile.memberID) }
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Invite \(name)")
            } else if canManage(profile) {
                if profile.state == .pending, profile.displayName != nil {
                    Button("Invite") { app.beginInvite(for: profile.memberID) }
                        .buttonStyle(.borderless)
                        .frame(minWidth: 44, minHeight: 44)
                        .disabled(app.isUpdatingPeople || app.isIssuingInvite)
                        .accessibilityLabel("Invite \(name)")
                }
                memberActions(profile, name: name)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func memberActions(_ profile: AppMemberProfile, name: String) -> some View {
        Menu {
            switch profile.state {
            case .active where profile.role == .member:
                Button(String(localized: "Transfer ownership")) {
                    confirmation = .transfer(profile.memberID, name)
                }
                Button(String(localized: "Detach wrong claim"), role: .destructive) {
                    confirmation = .detach(profile.memberID, name)
                }
                Button(String(localized: "Archive member"), role: .destructive) {
                    confirmation = .archive(profile.memberID, name)
                }
            case .pending where profile.displayName != nil:
                Button(String(localized: "Erase name"), role: .destructive) {
                    confirmation = .anonymize(profile.memberID, name)
                }
            case .pending, .active, .archived:
                EmptyView()
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.ink)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(app.isUpdatingPeople || app.isIssuingInvite)
        .accessibilityLabel(localizedFormat("Actions for %@", name))
    }

    private var inviteControlsSection: some View {
        Section {
            Button(action: app.beginPotInvite) {
                Label(String(localized: "Create pot invite"), systemImage: "link")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.ink)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(app.isIssuingInvite || app.isUpdatingPeople)
        } header: {
            Text(String(localized: "Invite link"))
        } footer: {
            Text(String(localized: "Anyone with a pot invite can request access. The owner must approve them before history appears."))
        }
    }

    private func issuedInviteSection(_ invite: ShareableInvite) -> some View {
        Section {
            VStack(spacing: 16) {
                InviteQRCodeView(url: invite.url)
                    .frame(width: 184, height: 184)
                VStack(spacing: 5) {
                    Text(String(localized: "Invite code"))
                        .font(.caption)
                        .foregroundStyle(palette.ink3)
                    Text(invite.code)
                        .font(.title2.monospaced().weight(.semibold))
                        .tracking(2)
                        .textSelection(.enabled)
                }
                ShareLink(item: invite.url) {
                    Label(String(localized: "Share invite"), systemImage: "square.and.arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(palette.bg)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(palette.ink, in: Capsule())
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(String(localized: "Share invite"))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        } header: {
            Text(String(localized: "Invite ready"))
        } footer: {
            Text(String(localized: "The link and code expire after 30 days. Numa Shared doesn’t store a recoverable copy of this link."))
        }
    }

    private var managedInvitesSection: some View {
        Section {
            ForEach(app.managedInvites, id: \.inviteID) { invite in
                HStack(spacing: 12) {
                    Image(systemName: invite.kind == .perMember
                        ? "person.crop.circle.badge.plus"
                        : "link")
                        .font(.title3)
                        .frame(width: 36, height: 36)
                        .background(palette.chip, in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        Text(managedInviteTitle(invite))
                            .font(.body.weight(.semibold))
                        Text(localizedFormat(
                            "Expires %@",
                            Date(
                                timeIntervalSince1970:
                                    Double(invite.expiresAtMillis) / 1_000
                            ).formatted(date: .abbreviated, time: .omitted)
                        ))
                        .font(.caption)
                        .foregroundStyle(palette.ink3)
                    }
                    Spacer(minLength: 8)
                    Button(String(localized: "Revoke"), role: .destructive) {
                        app.revokeInvite(invite.inviteID)
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
                    .buttonStyle(PressableButtonStyle())
                    .disabled(app.isUpdatingPeople || app.isIssuingInvite)
                }
                .padding(.vertical, 4)
            }
        } header: {
            Text(String(localized: "Invites"))
        } footer: {
            Text(String(localized: "Raw links aren’t stored. Revoke an invite if its link was shared by mistake."))
        }
    }

    private func managedInviteTitle(_ invite: ManagedInvite) -> String {
        guard let memberID = invite.pendingMemberID,
              let name = app.memberProfiles.first(where: {
                $0.memberID == memberID
              })?.displayName
        else { return String(localized: "Pot invite") }
        return localizedFormat("Invite for %@", name)
    }

    private func pendingClaimRow(_ claim: PendingInviteClaim) -> some View {
        let candidates = pendingProfiles(for: claim)
        let selected = selectedMemberID(for: claim, candidates: candidates)
        let selectedName = candidates.first { $0.memberID == selected }?
            .displayName ?? String(localized: "Unknown member")
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "person.crop.circle.badge.questionmark")
                    .font(.title2)
                    .frame(width: 40, height: 40)
                    .background(palette.chip, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(String(localized: "Join request"))
                        .font(.body.weight(.semibold))
                    Text(claim.chosenMemberID == nil
                        ? String(localized: "Choose an identity for this account.")
                        : localizedFormat("Requested identity: %@", selectedName))
                        .font(.caption)
                        .foregroundStyle(palette.ink3)
                }
            }

            if claim.chosenMemberID == nil, !candidates.isEmpty {
                Menu {
                    ForEach(candidates, id: \.memberID) { profile in
                        Button(profile.displayName ?? String(localized: "Unknown member")) {
                            claimSelections[claim.id] = profile.memberID
                        }
                    }
                } label: {
                    HStack {
                        Text(localizedFormat("Identity: %@", selectedName))
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption)
                    }
                    .foregroundStyle(palette.ink)
                    .frame(minHeight: 44)
                    .padding(.horizontal, 14)
                    .background(palette.chip, in: RoundedRectangle(cornerRadius: 14))
                }
                .accessibilityLabel(localizedFormat("Selected identity: %@", selectedName))
            }

            HStack(spacing: 10) {
                Button(String(localized: "Approve")) {
                    guard let selected else { return }
                    app.approvePendingInviteClaim(claim.id, as: selected)
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.bg)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(palette.ink, in: Capsule())
                .buttonStyle(PressableButtonStyle())
                .disabled(selected == nil || app.isUpdatingPeople)

                Button(String(localized: "Decline"), role: .destructive) {
                    app.rejectPendingInviteClaim(claim.id)
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.ink)
                .frame(maxWidth: .infinity, minHeight: 44)
                .overlay(Capsule().stroke(palette.hair, lineWidth: 1.5))
                .buttonStyle(PressableButtonStyle())
                .disabled(app.isUpdatingPeople)
            }
        }
        .padding(.vertical, 6)
    }

    private func canManage(_ profile: AppMemberProfile) -> Bool {
        guard app.isCurrentMemberOwner,
              profile.memberID != app.currentMemberID
        else { return false }
        switch profile.state {
        case .active:
            return profile.role == .member
        case .pending:
            return profile.displayName != nil
        case .archived:
            return false
        }
    }

    private func pendingProfiles(
        for claim: PendingInviteClaim
    ) -> [AppMemberProfile] {
        app.memberProfiles.filter { profile in
            profile.state == .pending
                && (claim.chosenMemberID == nil
                    || profile.memberID == claim.chosenMemberID)
        }
    }

    private func selectedMemberID(
        for claim: PendingInviteClaim,
        candidates: [AppMemberProfile]
    ) -> NumaSharedCore.MemberID? {
        claim.chosenMemberID
            ?? claimSelections[claim.id]
            ?? candidates.first?.memberID
    }

    @ViewBuilder
    private func personAvatar(name: String, unitID: UnitID?) -> some View {
        if let unitID,
           let unit = app.unitInfos[unitID],
           !unit.isWoven {
            AvatarView(unit: unit, size: 44, palette: palette)
        } else {
            Circle()
                .fill(palette.chip)
                .frame(width: 44, height: 44)
                .overlay {
                    Text(initials(for: name))
                        .font(NumaFont.rounded(15, weight: .semibold))
                        .foregroundStyle(palette.ink)
                }
        }
    }

    private func profileSubtitle(_ profile: AppMemberProfile) -> String {
        let role = switch profile.state {
        case .pending:
            String(localized: "Pending")
        case .archived:
            String(localized: "Archived")
        case .active where profile.role == .owner:
            String(localized: "Owner")
        case .active:
            String(localized: "Member")
        }
        guard profile.memberID == app.currentMemberID else { return role }
        return localizedFormat("%@ · You", role)
    }

    private func localName(_ value: String, fallback: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }

    private func initials(for name: String) -> String {
        let words = name.components(
            separatedBy: CharacterSet.alphanumerics.inverted
        ).filter { !$0.isEmpty }
        let initials = words.prefix(2).compactMap { word in
            word.first.map { String($0).uppercased() }
        }.joined(separator: "·")
        return initials.isEmpty ? "?" : initials
    }

    private func apply(_ confirmation: PeopleConfirmation) {
        switch confirmation {
        case let .detach(memberID, _):
            app.detachMemberClaim(memberID)
        case let .archive(memberID, _):
            app.archiveMember(memberID)
        case let .transfer(memberID, _):
            app.transferOwnership(to: memberID)
        case let .anonymize(memberID, _):
            app.anonymizePendingMember(memberID)
        case .leave:
            app.leaveCurrentPot()
        }
    }
}

/// The same permission action and status live beside notification settings
/// wherever they are shown; neither surface has to send the user to the other.
struct NotificationPermissionControl: View {
    @EnvironmentObject private var app: AppModel
    let palette: Pal.Palette

    var body: some View {
        Group {
            switch app.pushNotificationPermission {
            case .notDetermined:
                Button(action: app.enableNotifications) {
                    Label(
                        String(localized: "Allow notifications"),
                        systemImage: "bell"
                    )
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.ink)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityIdentifier("allow-notifications")
            case .denied:
                Label(
                    String(localized: "Notifications are off in iPhone Settings."),
                    systemImage: "bell.slash"
                )
                .font(.subheadline)
                .foregroundStyle(palette.ink2)
            case .authorized:
                Label(
                    String(localized: "Notifications are allowed on this iPhone."),
                    systemImage: "bell"
                )
                .font(.subheadline)
                .foregroundStyle(palette.ink2)
            }

        }
        .disabled(!app.isSyncEnabled || app.isUpdatingNotifications)
    }
}

private struct InviteQRCodeView: View {
    let url: URL

    var body: some View {
        Group {
            if let image = Self.image(for: url) {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.none)
                    .accessibilityLabel(String(localized: "Invite QR code"))
                    .accessibilityIdentifier("Invite QR code")
            } else {
                Image(systemName: "qrcode")
                    .resizable()
                    .scaledToFit()
                    .padding(30)
                    .accessibilityLabel(String(localized: "Invite QR code"))
                    .accessibilityIdentifier("Invite QR code")
            }
        }
        .padding(10)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16))
    }

    nonisolated private static func image(for url: URL) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(url.absoluteString.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(
            by: CGAffineTransform(scaleX: 10, y: 10)
        ),
        let cgImage = CIContext().createCGImage(output, from: output.extent)
        else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

private enum PeopleConfirmation: Identifiable {
    case detach(NumaSharedCore.MemberID, String)
    case archive(NumaSharedCore.MemberID, String)
    case transfer(NumaSharedCore.MemberID, String)
    case anonymize(NumaSharedCore.MemberID, String)
    case leave(String)

    var id: String {
        switch self {
        case let .detach(memberID, _): "detach-\(memberID)"
        case let .archive(memberID, _): "archive-\(memberID)"
        case let .transfer(memberID, _): "transfer-\(memberID)"
        case let .anonymize(memberID, _): "anonymize-\(memberID)"
        case .leave: "leave-pot"
        }
    }

    var title: String {
        switch self {
        case let .detach(_, name): localizedFormat("Detach %@?", name)
        case let .archive(_, name): localizedFormat("Archive %@?", name)
        case let .transfer(_, name): localizedFormat("Make %@ the owner?", name)
        case let .anonymize(_, name): localizedFormat("Erase %@’s name?", name)
        case .leave: String(localized: "Leave this pot?")
        }
    }

    var buttonTitle: String {
        switch self {
        case .detach: String(localized: "Detach claim")
        case .archive: String(localized: "Archive member")
        case .transfer: String(localized: "Transfer ownership")
        case .anonymize: String(localized: "Erase name")
        case .leave: String(localized: "Leave pot")
        }
    }

    var role: ButtonRole? {
        switch self {
        case .transfer: nil
        case .detach, .archive, .anonymize, .leave: .destructive
        }
    }

    var message: String {
        switch self {
        case .detach:
            String(localized: "The identity stays in the pot, but this account loses its claim.")
        case .archive:
            String(localized: "Past records stay visible. This member loses access to the pot.")
        case .transfer:
            String(localized: "You will remain a member. Only the new owner can manage people afterward.")
        case .anonymize:
            String(localized: "The pending identity remains available, but its saved name is erased.")
        case let .leave(message):
            message
        }
    }
}
