module.exports = {
  appId: 'io.github.jbrick2070.stageforge',
  productName: 'StageForge',
  electronVersion: require('../package.json').devDependencies.electron,
  directories: {
    app: 'desktop/build/app',
    buildResources: 'desktop/resources',
    output: 'desktop/build/release',
  },
  asar: true,
  files: ['**/*'],
  npmRebuild: false,
  win: {
    target: 'portable',
    icon: 'desktop/resources/icon.png',
    artifactName: 'StageForge-${version}-win-${arch}.${ext}',
    signExecutable: false,
  },
  mac: {
    target: 'zip',
    icon: 'desktop/resources/icon.png',
    category: 'public.app-category.music',
    artifactName: 'StageForge-${version}-mac-${arch}.${ext}',
    identity: '-',
    hardenedRuntime: false,
    extendInfo: { NSMicrophoneUsageDescription: 'StageForge uses microphone input when you select live audio for your show.' },
  },
};
