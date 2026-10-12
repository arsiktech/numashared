import Foundation

struct DevicePrivacyPreferences {
    private enum Key {
        static let hideAmounts = "privacy.hideAmounts"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hideAmounts: Bool {
        defaults.bool(forKey: Key.hideAmounts)
    }

    func setHideAmounts(_ hidden: Bool) {
        defaults.set(hidden, forKey: Key.hideAmounts)
    }
}
