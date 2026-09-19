plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
}
kotlin { jvmToolchain(17) }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    api("org.bouncycastle:bcprov-jdk18on:1.81")
    testImplementation(kotlin("test"))
}
tasks.test { useJUnitPlatform() }
