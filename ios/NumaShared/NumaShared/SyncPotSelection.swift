import NumaSharedCore
import NumaSharedSync

/// Chooses one active pot after authentication without silently discarding an
/// accountless history or creating an unrelated empty pot on a clean device.
nonisolated enum SyncPotSelection: Equatable, Sendable {
    case useLocal(needsPromotion: Bool)
    case adoptRemote(RemotePotDescriptor)

    static func decide(
        localPotID: PotID,
        localEventCount: Int,
        remotePots: [RemotePotDescriptor]
    ) -> SyncPotSelection {
        if let matching = remotePots.first(where: {
            $0.configuration.id == localPotID
        }) {
            return .adoptRemote(matching)
        }
        if localEventCount > 0 {
            return .useLocal(needsPromotion: true)
        }
        if let remote = remotePots.sorted(by: {
            $0.configuration.id.description < $1.configuration.id.description
        }).first {
            return .adoptRemote(remote)
        }
        return .useLocal(needsPromotion: true)
    }
}
