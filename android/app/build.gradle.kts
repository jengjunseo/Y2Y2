plugins { id("com.android.application") }

android {
    namespace = "dev.y2y2.engine"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.y2y2.engine"
        minSdk = 29
        targetSdk = 36
        versionCode = 3
        versionName = "0.3.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    packaging {
        jniLibs.useLegacyPackaging = true
    }
}

dependencies {
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
}
