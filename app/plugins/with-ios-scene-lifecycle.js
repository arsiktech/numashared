// Adopt the UIScene life cycle on iOS.
//
// Apps linked against the iOS 27 SDK must use scenes. Without them UIKit stops the
// app at launch (SIGTRAP in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption,
// "UIScene life cycle is required for apps built with this SDK", TN3187).
// Expo SDK 57's prebuild template still creates its own UIWindow in AppDelegate, and
// scene support only lands in SDK 58, so this plugin adds it until we upgrade.
//
// What it does to the generated project:
// 1. Info.plist gets a single-scene UIApplicationSceneManifest pointing at SceneDelegate.
// 2. AppDelegate keeps building the React Native factory, but no longer creates a window
//    or starts React Native. It keeps the launch options for the scene.
// 3. SceneDelegate (appended to AppDelegate.swift, so no pbxproj edits are needed) builds
//    the window from the UIWindowScene and starts React Native in it.
// 4. Under scenes UIKit stops calling the app delegate's URL, user-activity and
//    foreground/background methods. SceneDelegate forwards them to AppDelegate, so
//    ExpoAppDelegate's subscribers (expo-linking, expo-router, notifications) still see them.
//
// Remove this plugin when the app moves to an Expo SDK whose template adopts scenes.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const MARKER = '// with-ios-scene-lifecycle';

const SCENE_DELEGATE = `

${MARKER}: UIKit creates the window through this scene delegate.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = appDelegate,
      let factory = appDelegate.reactNativeFactory
    else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    var launchOptions = appDelegate.launchOptions ?? [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
    window.makeKeyAndVisible()

    // Cold-start links: hand them to the app delegate chain, as a pre-scene launch would.
    for context in connectionOptions.urlContexts {
      openURL(context)
    }
    for activity in connectionOptions.userActivities {
      continueActivity(activity)
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      openURL(context)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    continueActivity(userActivity)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }

  private func openURL(_ context: UIOpenURLContext) {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let source = context.options.sourceApplication {
      options[.sourceApplication] = source
    }
    if let annotation = context.options.annotation {
      options[.annotation] = annotation
    }
    options[.openInPlace] = context.options.openInPlace
    _ = appDelegate?.application(UIApplication.shared, open: context.url, options: options)
  }

  private func continueActivity(_ activity: NSUserActivity) {
    _ = appDelegate?.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
  }
}
`;

// The template's window + startReactNative block inside didFinishLaunchingWithOptions.
const START_BLOCK =
  /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/;

const WINDOW_PROPERTY = '  var window: UIWindow?\n';

function patchAppDelegate(contents) {
  if (contents.includes(MARKER)) return contents;
  if (!START_BLOCK.test(contents)) {
    throw new Error(
      "with-ios-scene-lifecycle: AppDelegate.swift no longer matches the Expo SDK 57 template; update or remove this plugin.",
    );
  }
  if (!contents.includes(WINDOW_PROPERTY)) {
    throw new Error("with-ios-scene-lifecycle: could not find AppDelegate's window property.");
  }
  return (
    contents
      .replace(
        START_BLOCK,
        `    ${MARKER}: SceneDelegate creates the window and starts React Native.\n    self.launchOptions = launchOptions\n`,
      )
      .replace(
        WINDOW_PROPERTY,
        `${WINDOW_PROPERTY}  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n`,
      ) + SCENE_DELEGATE
  );
}

const withIosSceneLifecycle = (config) => {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });

  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('with-ios-scene-lifecycle: expected a Swift AppDelegate.');
    }
    cfg.modResults.contents = patchAppDelegate(cfg.modResults.contents);
    return cfg;
  });
};

module.exports = withIosSceneLifecycle;
module.exports.patchAppDelegate = patchAppDelegate;
