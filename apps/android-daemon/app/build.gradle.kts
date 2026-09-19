plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "io.cuaremote.daemon"
    compileSdk = 37
    defaultConfig { applicationId = "io.cuaremote.daemon"; minSdk = 29; targetSdk = 37; versionCode = 1; versionName = "0.1.0"; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" }
    packaging { resources.excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF" }
}
kotlin { jvmToolchain(17) }

dependencies {
    implementation(project(":apps:android-shared:core-protocol"))
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
