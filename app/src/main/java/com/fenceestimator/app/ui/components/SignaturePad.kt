package com.fenceestimator.app.ui.components

import android.graphics.Bitmap
import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

@Composable
fun SignaturePadDialog(onSave: (String) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var strokes by remember { mutableStateOf(listOf<List<Offset>>()) }
    var currentStroke by remember { mutableStateOf(listOf<Offset>()) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sign to Accept") },
        text = {
            Column {
                Text("Sign below with your finger.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Canvas(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(220.dp)
                        .background(Color.White)
                        .onSizeChanged { canvasSize = it }
                        .pointerInput(Unit) {
                            detectDragGestures(
                                onDragStart = { offset -> currentStroke = listOf(offset) },
                                onDragEnd = {
                                    if (currentStroke.isNotEmpty()) strokes = strokes + listOf(currentStroke)
                                    currentStroke = emptyList()
                                }
                            ) { change, _ ->
                                currentStroke = currentStroke + change.position
                            }
                        }
                ) {
                    (strokes + listOf(currentStroke)).forEach { stroke ->
                        for (i in 0 until stroke.size - 1) {
                            drawLine(Color.Black, stroke[i], stroke[i + 1], strokeWidth = 5f, cap = androidx.compose.ui.graphics.StrokeCap.Round)
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val path = renderSignature(context, strokes, canvasSize)
                    if (path != null) onSave(path)
                },
                enabled = strokes.isNotEmpty()
            ) { Text("Save Signature") }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { strokes = emptyList(); currentStroke = emptyList() }) { Text("Clear") }
                OutlinedButton(onClick = onDismiss) { Text("Cancel") }
            }
        }
    )
}

private fun renderSignature(context: android.content.Context, strokes: List<List<Offset>>, size: IntSize): String? {
    if (size.width == 0 || size.height == 0) return null
    val bitmap = Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bitmap)
    canvas.drawColor(android.graphics.Color.WHITE)
    val paint = Paint().apply {
        color = android.graphics.Color.BLACK
        strokeWidth = 5f
        isAntiAlias = true
        strokeCap = Paint.Cap.ROUND
        style = Paint.Style.STROKE
    }
    strokes.forEach { stroke ->
        for (i in 0 until stroke.size - 1) {
            canvas.drawLine(stroke[i].x, stroke[i].y, stroke[i + 1].x, stroke[i + 1].y, paint)
        }
    }
    val dir = File(context.filesDir, "signatures").apply { mkdirs() }
    val file = File(dir, "signature_${System.currentTimeMillis()}_${UUID.randomUUID()}.png")
    FileOutputStream(file).use { out -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, out) }
    return file.absolutePath
}
