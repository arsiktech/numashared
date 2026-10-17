import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { patchAppDelegate } = require('./with-ios-scene-lifecycle.js');

// AppDelegate.swift as Expo SDK 57 prebuild generates it.
const SDK57_APP_DELEGATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe('with-ios-scene-lifecycle', () => {
  it('moves window creation and React Native start into a scene delegate', () => {
    const patched = patchAppDelegate(SDK57_APP_DELEGATE);

    expect(patched).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
    expect(patched).toContain('self.launchOptions = launchOptions');
    expect(patched).toContain('var launchOptions: [UIApplication.LaunchOptionsKey: Any]?');
    expect(patched).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate');
    expect(patched).toContain('UIWindow(windowScene: windowScene)');
    expect(patched.match(/startReactNative\(/g)).toHaveLength(1);
  });

  it('forwards links and lifecycle events to the app delegate', () => {
    const patched = patchAppDelegate(SDK57_APP_DELEGATE);

    expect(patched).toContain('openURLContexts');
    expect(patched).toContain('func scene(_ scene: UIScene, continue userActivity: NSUserActivity)');
    expect(patched).toContain('connectionOptions.urlContexts');
    expect(patched).toContain('connectionOptions.userActivities');
    expect(patched).toContain('applicationDidBecomeActive');
    expect(patched).toContain('applicationDidEnterBackground');
  });

  it('is idempotent', () => {
    const once = patchAppDelegate(SDK57_APP_DELEGATE);
    expect(patchAppDelegate(once)).toBe(once);
  });

  it('fails loudly when the template changes', () => {
    expect(() => patchAppDelegate('class AppDelegate {}')).toThrow(/no longer matches/);
  });
});
