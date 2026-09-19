pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "CuaRemoteAndroid"
include(":apps:android-shared:core-protocol")
include(":apps:android-daemon:app")
include(":apps:android:app")
