import SwiftUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var app: AppModel
    let palette: Pal.Palette
    @State private var exportRequestID: UUID?
    @State private var exportShare: CSVShareItem?
    @State private var settingsVisible = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    // UIKit-backed titles: the audit flags these SwiftUI
                    // button labels as synthetic AccessibilityNodes that "may
                    // be clipped" at larger Dynamic Type sizes (precedent 5d860f5).
                    Button(action: app.openPeopleFromSettings) {
                        Label {
                            WrappingTextLabel(
                                text: String(localized: "People & ownership"),
                                size: 17,
                                weight: .regular,
                                color: palette.ink
                            )
                        } icon: {
                            Image(systemName: "person.2")
                        }
                    }
                    .accessibilityHint(String(
                        localized: "Manage people, invitations, and the pot owner."
                    ))
                    if !app.isSyncEnabled {
                        Button(action: app.beginSyncSetup) {
                            Label {
                                WrappingTextLabel(
                                    text: app.syncPresentation.title,
                                    size: 17,
                                    weight: .regular,
                                    color: palette.ink
                                )
                            } icon: {
                                Image(systemName: "icloud")
                            }
                        }
                        .accessibilityIdentifier("enable-sync")
                        .accessibilityHint(String(
                            localized: "Keep this pot synced with Sign in with Apple."
                        ))
                    }
                }

                Section {
                    Toggle(
                        String(localized: "Mute this pot"),
                        isOn: Binding(
                            get: { app.isPotMuted },
                            set: { app.setPotMuted($0) }
                        )
                    )
                    .tint(palette.ink)
                    .disabled(!app.isSyncEnabled || app.isUpdatingNotifications)
                    .accessibilityIdentifier("settings-pot-mute")

                    if !app.isSyncEnabled {
                        Text(String(
                            localized: "Enable sync before changing this pot’s notifications."
                        ))
                        .font(.footnote)
                        .foregroundStyle(palette.ink2)
                    } else {
                        NotificationPermissionControl(palette: palette)
                        if let error = app.notificationErrorMessage {
                            Button(String(localized: "Retry")) {
                                app.refreshSettingsNotificationState()
                            }
                            .frame(minHeight: 44)
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(palette.ink2)
                        }
                        Text(String(localized: "Alerts never include amounts."))
                        .font(.footnote)
                        .foregroundStyle(palette.ink2)
                    }
                } header: {
                    Text(String(localized: "Notifications"))
                }

                Section {
                    Toggle(
                        String(localized: "Hide amounts"),
                        isOn: Binding(
                            get: { app.hideAmounts },
                            set: { app.setHideAmounts($0) }
                        )
                    )
                    .tint(palette.ink)
                    .accessibilityIdentifier("hide-amounts-toggle")

                    Text(localizedFormat(
                        "Amounts appear as %@ only on this iPhone.",
                        app.hiddenAmountPlaceholder
                    ))
                        .font(.footnote)
                        .foregroundStyle(palette.ink2)
                } header: {
                    Text(String(localized: "Privacy"))
                }

                Section {
                    Button(action: exportCSV) {
                        Label(
                            app.isPreparingCSVExport
                                ? String(localized: "Preparing CSV")
                                : String(localized: "Export CSV"),
                            systemImage: "square.and.arrow.up"
                        )
                    }
                    .disabled(app.isPreparingCSVExport || app.isSigningOut || app.isDeletingAccount)
                    .accessibilityIdentifier("prepare-csv-export")


                    if let count = app.csvExportRowCount {
                        Text(localizedFormat("%lld events in this export", Int64(count)))
                            .font(.footnote)
                            .foregroundStyle(palette.ink2)
                    }

                    if let error = app.csvExportErrorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(palette.ink2)
                            .accessibilityLabel(localizedFormat("Export error: %@", error))
                    }

                    if let warning = app.csvExportPrivacyWarning {
                        Text(warning)
                            .font(.footnote)
                            .foregroundStyle(palette.ink2)
                            .accessibilityIdentifier("csv-export-privacy-warning")
                    }

                    if let url = app.csvExportURL, app.csvExportPrivacyWarning != nil {
                        Button { shareSavedHistory(url) } label: {
                            Label(
                                String(localized: "Share saved history"),
                                systemImage: "square.and.arrow.up"
                            )
                        }
                        .disabled(app.isPreparingCSVExport || app.isSigningOut || app.isDeletingAccount)
                        .accessibilityIdentifier("share-csv-export")
                    }

                    Text(String(localized: "The file contains exact amounts even when Hide amounts is on. Deleted authored text stays redacted."))
                        .font(.footnote)
                        .foregroundStyle(palette.ink2)
                        .accessibilityIdentifier("csv-export-disclosure")
                } header: {
                    Text(String(localized: "Export"))
                }

                Section {
                    if let supportURL = AppSupportInfo.supportDestination() {
                        Link(destination: supportURL) {
                            Label(
                                String(localized: "Contact support"),
                                systemImage: "envelope"
                            )
                        }
                        .accessibilityHint(String(
                            localized: "Includes the app version, system version, and an anonymous diagnostic ID."
                        ))
                    }

                    NavigationLink {
                        OpenSourceLicensesView(palette: palette)
                    } label: {
                        Label(
                            String(localized: "Open-source licenses"),
                            systemImage: "doc.text"
                        )
                    }

                    LabeledContent(
                        String(localized: "Numa Shared"),
                        value: AppSupportInfo.versionDisplay()
                    )
                } header: {
                    Text(String(localized: "About"))
                        .font(.footnote)
                        .textCase(nil)
                }

                if app.canSignOut || app.canDeleteAccount {
                    Section {
                        if app.canSignOut {
                            Button(
                                app.isSigningOut
                                    ? String(localized: "Signing out")
                                    : String(localized: "Sign out"),
                                role: .destructive,
                                action: app.requestSignOut
                            )
                            .disabled(app.isSigningOut || app.isDeletingAccount)
                            .accessibilityIdentifier("sign-out")
                        }

                        if app.canDeleteAccount {
                            Button(
                                app.isLoadingAccountDeletion
                                    ? String(localized: "Loading deletion details")
                                    : app.isDeletingAccount
                                        ? String(localized: "Deleting account")
                                        : String(localized: "Delete account"),
                                role: .destructive,
                                action: app.requestAccountDeletion
                            )
                            .disabled(
                                app.isLoadingAccountDeletion
                                    || app.isDeletingAccount
                                    || app.isSigningOut
                            )
                            .accessibilityIdentifier("delete-account")
                        }

                        if let error = app.signOutErrorMessage {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(palette.ink2)
                        }

                        if let error = app.accountDeletionErrorMessage {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(palette.ink2)
                                .accessibilityLabel(
                                    localizedFormat("Deletion error: %@", error)
                                )
                        }
                    } header: {
                        Text(String(localized: "Account"))
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: app.dismissSettings) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel(String(localized: "Done"))
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.bg)
            .foregroundStyle(palette.ink)
            .navigationTitle(String(localized: "Settings"))
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(
                String(localized: "Sign out?"),
                isPresented: Binding(
                    get: { app.signOutConfirmationPresented },
                    set: { presented in
                        guard app.signOutConfirmationPresented != presented else {
                            return
                        }
                        DispatchQueue.main.async {
                            app.signOutConfirmationPresented = presented
                        }
                    }
                ),
                titleVisibility: .visible
            ) {
                if app.unsyncedEventCount > 0 {
                    Button(String(localized: "Sync now"), action: app.syncBeforeSignOut)
                    Button(
                        app.unsyncedEventCount == 1
                            ? String(localized: "Sign out and lose 1 record")
                            : localizedFormat(
                                "Sign out and lose %lld records",
                                Int64(app.unsyncedEventCount)
                            ),
                        role: .destructive,
                        action: app.confirmSignOut
                    )
                } else {
                    Button(
                        String(localized: "Sign out"),
                        role: .destructive,
                        action: app.confirmSignOut
                    )
                }
                Button(String(localized: "Cancel"), role: .cancel) {}
            } message: {
                Text(app.signOutConfirmationMessage)
            }
            .confirmationDialog(
                String(localized: "Delete account?"),
                isPresented: Binding(
                    get: { app.accountDeletionConfirmationPresented },
                    set: { presented in
                        guard app.accountDeletionConfirmationPresented != presented else {
                            return
                        }
                        DispatchQueue.main.async {
                            app.accountDeletionConfirmationPresented = presented
                        }
                    }
                ),
                titleVisibility: .visible
            ) {
                Button(
                    String(localized: "Delete account"),
                    role: .destructive,
                    action: app.confirmAccountDeletion
                )
                Button(String(localized: "Cancel"), role: .cancel) {}
            } message: {
                Text(app.accountDeletionPreviewMessage)
            }
        }
        .sheet(item: $exportShare) { item in
            CSVShareSheet(url: item.url)
        }
        .onAppear { settingsVisible = true }
        .onDisappear {
            settingsVisible = false
            exportRequestID = nil
            // A child system share sheet may cover Settings. Its valid item
            // stays until dismissal; leaving Settings always clears it.
            if !app.settingsPresented { exportShare = nil }
        }
        .onChange(of: app.settingsPresented) { _, presented in
            if !presented {
                settingsVisible = false
                clearExportPresentation()
            }
        }
        .onChange(of: app.csvExportURL) { _, url in
            if exportShare?.url != url { exportShare = nil }
            // Preparation intentionally discards the preceding file. A nil URL
            // outside that operation is source invalidation or failure.
            if url == nil && !app.isPreparingCSVExport { exportRequestID = nil }
        }
        .onChange(of: app.isPreparingCSVExport) { _, preparing in
            if !preparing { exportRequestID = nil }
        }
        .onChange(of: app.isSigningOut) { _, signingOut in
            if signingOut { clearExportPresentation() }
        }
        .onChange(of: app.isDeletingAccount) { _, deleting in
            if deleting { clearExportPresentation() }
        }
    }

    private func exportCSV() {
        let requestID = UUID()
        exportRequestID = requestID
        exportShare = nil
        app.prepareCSVExport { url, privacyIsCurrent in
            guard exportRequestID == requestID else { return }
            exportRequestID = nil
            guard settingsVisible, app.settingsPresented,
                  app.csvExportURL == url, privacyIsCurrent,
                  app.csvExportPrivacyWarning == nil,
                  !app.isSigningOut, !app.isDeletingAccount else { return }
            exportShare = CSVShareItem(url: url)
        }
    }

    private func shareSavedHistory(_ url: URL) {
        guard settingsVisible, app.settingsPresented,
              app.csvExportURL == url, app.csvExportPrivacyWarning != nil,
              !app.isPreparingCSVExport, !app.isSigningOut, !app.isDeletingAccount else { return }
        exportShare = CSVShareItem(url: url)
    }

    private func clearExportPresentation() {
        exportRequestID = nil
        exportShare = nil
    }
}

private struct CSVShareItem: Identifiable {
    let url: URL
    var id: URL { url }
}

private struct CSVShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.view.accessibilityIdentifier = "csv-share-sheet"
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct OpenSourceLicensesView: View {
    let palette: Pal.Palette

    var body: some View {
        List {
            Section {
                if let licenseURL = URL(
                    string: "https://github.com/groue/GRDB.swift/blob/master/LICENSE"
                ) {
                    Link("GRDB.swift", destination: licenseURL)
                }
                Text(String(localized: "MIT License"))
                    .foregroundStyle(palette.ink2)
            }
            Section {
                if let licenseURL = URL(
                    string: "https://github.com/get-convex/convex-swift/blob/main/LICENSE"
                ) {
                    Link("Convex Swift", destination: licenseURL)
                }
                Text(String(localized: "Apache License 2.0"))
                    .foregroundStyle(palette.ink2)
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.bg)
        .foregroundStyle(palette.ink)
        .navigationTitle(String(localized: "Open-source licenses"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
