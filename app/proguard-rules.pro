# Add project specific ProGuard rules here.
-keep class com.tom_roush.** { *; }

# ---------------------------------------------------------------------------
# Release shrinking keep rules.
#
# Everything below is reflective. R8 cannot see these uses, so without the
# rules it removes or renames code that is genuinely needed and the app fails
# at RUNTIME -- which unit tests never catch, because they run unshrunk. Each
# block names what breaks so nobody deletes one to quieten a warning.
# ---------------------------------------------------------------------------

# kotlinx.serialization: every @Serializable class is (de)serialised by a
# generated companion looked up by name. Losing it means every cloud read and
# write fails to parse -- sync silently stops working.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.fenceestimator.app.**$$serializer { *; }
-keepclassmembers class com.fenceestimator.app.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep class com.fenceestimator.app.cloud.** { *; }
-keep class com.fenceestimator.app.data.** { *; }

# Room: entities and DAOs are matched by name at runtime, and column names come
# from field names. Renaming a field renames a column and the migration chain
# stops matching the schema.
-keep class * extends androidx.room.RoomDatabase { *; }
-keep @androidx.room.Entity class * { *; }
-dontwarn androidx.room.paging.**

# Ktor + Supabase pick engines and serializers reflectively.
-keep class io.ktor.** { *; }
-keep class io.github.jan.supabase.** { *; }
-dontwarn io.ktor.**
-dontwarn org.slf4j.**

# Enum names are persisted as text in Room and in the cloud. Obfuscating them
# turns every saved status, role and payment method into an unreadable value.
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# PDFBox ships optional code paths this app never calls; they are absent
# rather than broken.
-dontwarn com.tom_roush.pdfbox.**
-dontwarn javax.**
