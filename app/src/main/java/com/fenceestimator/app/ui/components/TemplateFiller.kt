package com.fenceestimator.app.ui.components

object TemplateFiller {
    fun fillOrderTemplate(
        template: String,
        customerName: String,
        address: String,
        lineItems: String,
        total: String,
        businessName: String
    ): String = template
        .replace("{customerName}", customerName)
        .replace("{address}", address)
        .replace("{lineItems}", lineItems)
        .replace("{total}", total)
        .replace("{businessName}", businessName)

    fun fillHoaTemplate(
        template: String,
        address: String,
        fenceType: String,
        height: String,
        material: String,
        businessName: String,
        phone: String
    ): String = template
        .replace("{address}", address)
        .replace("{fenceType}", fenceType)
        .replace("{height}", height)
        .replace("{material}", material)
        .replace("{businessName}", businessName)
        .replace("{phone}", phone)

    fun fillReviewTemplate(
        template: String,
        customerName: String,
        businessName: String
    ): String = template
        .replace("{customerName}", customerName)
        .replace("{businessName}", businessName)
}
