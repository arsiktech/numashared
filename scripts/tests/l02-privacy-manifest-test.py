#!/usr/bin/env python3
"""Focused L02 manifest contract; optionally inspect a built simulator app.

Run: python3 scripts/tests/l02-privacy-manifest-test.py [path/to/NumaShared.app]
This is not Apple's archive privacy report or a substitute for L16.
"""
import plistlib
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "ios/NumaShared/NumaShared"
BUILT_APP = Path(sys.argv.pop()) if len(sys.argv) > 1 else None
EXPECTED_TYPES = {
    "Name", "EmailAddress", "OtherFinancialInfo", "PurchaseHistory",
    "OtherUserContent", "UserID", "DeviceID", "CustomerSupport", "OtherDiagnosticData",
}


class PrivacyManifestContract(unittest.TestCase):
    def setUp(self):
        self.manifest = plistlib.loads((APP / "PrivacyInfo.xcprivacy").read_bytes())

    def test_required_reasons_are_specific_to_app_uses(self):
        self.assertEqual(self.manifest["NSPrivacyAccessedAPITypes"], [
            {"NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
             "NSPrivacyAccessedAPITypeReasons": ["CA92.1"]},
            {"NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategorySystemBootTime",
             "NSPrivacyAccessedAPITypeReasons": ["35F9.1"]},
        ])
        preferences = (APP / "PrivacyPreferences.swift").read_text()
        self.assertIn("UserDefaults = .standard", preferences)
        self.assertIn('"privacy.hideAmounts"', preferences)
        self.assertIn("ProcessInfo.processInfo.systemUptime", (APP / "AppModel.swift").read_text())

    def test_collection_is_explicit_linked_functionality_without_tracking(self):
        self.assertIs(self.manifest["NSPrivacyTracking"], False)
        self.assertEqual(self.manifest["NSPrivacyTrackingDomains"], [])
        rows = self.manifest["NSPrivacyCollectedDataTypes"]
        self.assertEqual(len(rows), len(EXPECTED_TYPES))
        self.assertEqual({row["NSPrivacyCollectedDataType"] for row in rows},
                         {"NSPrivacyCollectedDataType" + t for t in EXPECTED_TYPES})
        for row in rows:
            self.assertIs(row["NSPrivacyCollectedDataTypeLinked"], True)
            self.assertIs(row["NSPrivacyCollectedDataTypeTracking"], False)
            self.assertEqual(row["NSPrivacyCollectedDataTypePurposes"],
                             ["NSPrivacyCollectedDataTypePurposeAppFunctionality"])

    def test_manifest_is_in_app_synchronized_resource_membership(self):
        project = ROOT / "ios/NumaShared/NumaShared.xcodeproj/project.pbxproj"
        result = subprocess.run(["plutil", "-convert", "xml1", "-o", "-", str(project)],
                                check=True, capture_output=True)
        objects = plistlib.loads(result.stdout)["objects"]
        target = next(o for o in objects.values()
                      if o.get("isa") == "PBXNativeTarget" and o.get("name") == "NumaShared")
        groups = [objects[g] for g in target["fileSystemSynchronizedGroups"]]
        group = next(g for g in groups if g.get("path") == "NumaShared")
        for exception_id in group.get("exceptions", []):
            self.assertNotIn("PrivacyInfo.xcprivacy", objects[exception_id].get("membershipExceptions", []))
        self.assertTrue(any(objects[p]["isa"] == "PBXResourcesBuildPhase" for p in target["buildPhases"]))

    @unittest.skipUnless(BUILT_APP, "pass a built app to check copied resources")
    def test_built_app_has_exact_manifest_and_dependency_resource(self):
        assert BUILT_APP is not None
        self.assertEqual(plistlib.loads((BUILT_APP / "PrivacyInfo.xcprivacy").read_bytes()), self.manifest)
        manifests = list(BUILT_APP.rglob("PrivacyInfo.xcprivacy"))
        self.assertTrue(any("GRDB" in str(p.relative_to(BUILT_APP)) for p in manifests), manifests)
        info = plistlib.loads((BUILT_APP / "Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], "tech.arsik.numashared")
        self.assertEqual(info["UIDeviceFamily"], [1])
        print("Built privacy manifests:", [str(p.relative_to(BUILT_APP)) for p in manifests])


if __name__ == "__main__":
    unittest.main(verbosity=2)
