plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("org.jetbrains.kotlin.plugin.compose")
}
android {
    namespace = "io.cuaremote.controller"
    compileSdk = 37
    defaultConfig { applicationId = "io.cuaremote.controller"; minSdk = 29; targetSdk = 37; versionCode = 1; versionName = "0.1.0" }
    buildFeatures { compose = true }
    packaging { resources.excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF" }
}
kotlin { jvmToolchain(17) }
dependencies {
    implementation(project(":apps:android-shared:core-protocol"))
    implementation(platform("androidx.compose:compose-bom:2025.05.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    testImplementation(kotlin("test"))
}
