const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withAndroidRelease(config) {
  return withAppBuildGradle(config, (config) => {
    const file = config.modResults;
    if (file.language !== 'groovy') throw new Error('Android release signing requires Groovy build.gradle');
    if (file.contents.includes('// numa-upload-signing')) return config;
    const anchor = '    signingConfigs {';
    if (!file.contents.includes(anchor)) throw new Error('Missing Android signingConfigs');
    file.contents = file.contents.replace(anchor, `${anchor}
        // numa-upload-signing: credentials are supplied only through the build environment.
        upload {
            def uploadStore = System.getenv('NUMA_ANDROID_KEYSTORE')
            if (uploadStore) storeFile file(uploadStore)
            storePassword System.getenv('NUMA_ANDROID_STORE_PASSWORD')
            keyAlias System.getenv('NUMA_ANDROID_KEY_ALIAS') ?: 'upload'
            keyPassword System.getenv('NUMA_ANDROID_KEY_PASSWORD')
        }`);
    const release = /release \{([\s\S]*?)signingConfig signingConfigs\.debug/;
    if (!release.test(file.contents)) throw new Error('Missing template release signing configuration');
    file.contents = file.contents.replace(release, 'release {$1signingConfig signingConfigs.upload');
    file.contents += `
// Never silently produce a debug-signed release when upload credentials are absent.
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.project == project && it.name in ['packageRelease', 'signReleaseBundle'] }) {
        ['NUMA_ANDROID_KEYSTORE', 'NUMA_ANDROID_STORE_PASSWORD', 'NUMA_ANDROID_KEY_PASSWORD'].each { name ->
            if (!System.getenv(name)) throw new GradleException("Missing release signing environment: " + name)
        }
    }
}
`;
    return config;
  });
};
