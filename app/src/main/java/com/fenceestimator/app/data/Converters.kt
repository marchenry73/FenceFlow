package com.fenceestimator.app.data

import androidx.room.TypeConverter

class Converters {
    @TypeConverter
    fun fromJobStatus(value: JobStatus): String = value.name

    @TypeConverter
    fun toJobStatus(value: String): JobStatus =
        runCatching { JobStatus.valueOf(value) }.getOrDefault(JobStatus.DRAFT)

    @TypeConverter
    fun fromMaterialCategory(value: MaterialCategory): String = value.name

    @TypeConverter
    fun toMaterialCategory(value: String): MaterialCategory =
        runCatching { MaterialCategory.valueOf(value) }.getOrDefault(MaterialCategory.MISC)

    @TypeConverter
    fun fromMaterialRole(value: MaterialRole): String = value.name

    @TypeConverter
    fun toMaterialRole(value: String): MaterialRole =
        runCatching { MaterialRole.valueOf(value) }.getOrDefault(MaterialRole.NONE)

    @TypeConverter
    fun fromFenceType(value: FenceType): String = value.name

    @TypeConverter
    fun toFenceType(value: String): FenceType =
        runCatching { FenceType.valueOf(value) }.getOrDefault(FenceType.VINYL)

    @TypeConverter
    fun fromWoodStyle(value: WoodStyle): String = value.name

    @TypeConverter
    fun toWoodStyle(value: String): WoodStyle =
        runCatching { WoodStyle.valueOf(value) }.getOrDefault(WoodStyle.PRIVACY)

    @TypeConverter
    fun fromAluminumStyle(value: AluminumStyle): String = value.name

    @TypeConverter
    fun toAluminumStyle(value: String): AluminumStyle =
        runCatching { AluminumStyle.valueOf(value) }.getOrDefault(AluminumStyle.RACKABLE)

    @TypeConverter
    fun fromPhotoKind(value: PhotoKind): String = value.name

    @TypeConverter
    fun toPhotoKind(value: String): PhotoKind =
        runCatching { PhotoKind.valueOf(value) }.getOrDefault(PhotoKind.JOBSITE)

    @TypeConverter
    fun fromInventoryKind(value: InventoryKind): String = value.name

    @TypeConverter
    fun toInventoryKind(value: String): InventoryKind =
        runCatching { InventoryKind.valueOf(value) }.getOrDefault(InventoryKind.TOOL)

    @TypeConverter
    fun fromPaymentStatus(value: PaymentStatus): String = value.name

    @TypeConverter
    fun toPaymentStatus(value: String): PaymentStatus =
        runCatching { PaymentStatus.valueOf(value) }.getOrDefault(PaymentStatus.UNPAID)

    @TypeConverter
    fun fromHoaApprovalStatus(value: HoaApprovalStatus): String = value.name

    @TypeConverter
    fun toHoaApprovalStatus(value: String): HoaApprovalStatus =
        runCatching { HoaApprovalStatus.valueOf(value) }.getOrDefault(HoaApprovalStatus.NOT_REQUIRED)

    @TypeConverter
    fun fromPermitStatus(value: PermitStatus): String = value.name

    @TypeConverter
    fun toPermitStatus(value: String): PermitStatus =
        runCatching { PermitStatus.valueOf(value) }.getOrDefault(PermitStatus.NOT_REQUIRED)

    @TypeConverter
    fun fromExpenseCategory(value: ExpenseCategory): String = value.name

    @TypeConverter
    fun toExpenseCategory(value: String): ExpenseCategory =
        runCatching { ExpenseCategory.valueOf(value) }.getOrDefault(ExpenseCategory.OTHER)

    @TypeConverter
    fun fromJobStepKind(value: JobStepKind): String = value.name

    @TypeConverter
    fun toJobStepKind(value: String): JobStepKind =
        runCatching { JobStepKind.valueOf(value) }.getOrDefault(JobStepKind.INSTALL)

    @TypeConverter
    fun fromSiteMarkerKind(value: SiteMarkerKind): String = value.name

    @TypeConverter
    fun toSiteMarkerKind(value: String): SiteMarkerKind =
        runCatching { SiteMarkerKind.valueOf(value) }.getOrDefault(SiteMarkerKind.OBSTACLE)
}
