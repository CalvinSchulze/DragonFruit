//! Floyd-Steinberg energy-based dithering for low-bit-depth display systems.

use crate::rle::{RleRun, RleAccum, emit_row, emit_zero_rows};

/// Lowest desired energy the binned lookup table covers.
const MIN_ENERGY: f32 = -0.5;
/// Maps the 2.0-wide energy span onto the 4096 bins.
const ENERGY_SCALE: f32 = 2047.5;

/// Precomputed energy tables and target palette for Floyd-Steinberg dithering.
///
/// Integrates a highly optimized O(1) binned lookup table (Dither-LUT) that pins
/// to L1 Data Cache (<20KB), completely bypassing costly nearest-neighbor search loops
/// and eliminating branch mispredictions.
pub struct DitherPaletteV3 {
    /// Maps 8-bit input grayscale directly to physical energy based on the job LUT and gamma:
    /// E = (lut[V] / 255.0) ^ gamma
    pub source_energy: [f32; 256],
    
    /// Target PWM byte values for the low-bit-depth palette levels (e.g. 8 levels for 3-bit).
    pub target_bytes: Vec<u8>,
    
    /// Maps each target palette index to its corresponding physical energy level.
    pub target_energy: Vec<f32>,

    /// --- High Performance O(1) Binned Lookup Fields ---
    /// Precomputed target bytes corresponding to each of the 4096 bins for desired energy range [-0.5, 1.5]
    pub bin_bytes: [u8; 4096],

    /// Precomputed target energy corresponding to each of the 4096 bins for desired energy range [-0.5, 1.5]
    pub bin_energy: [f32; 4096],
}

impl DitherPaletteV3 {
    /// Create and precompute a new dithering palette with binned lookup structures.
    ///
    /// `bit_depth` must already be in the 2..=7 range dithering is defined for;
    /// callers get that from [`SliceJobV3::effective_dither_bit_depth`], which
    /// declines to dither at all outside it. The clamp below is only a last-resort
    /// guard against a palette with 1 or 256 levels — reaching it means the caller
    /// skipped that gate, so it trips a debug assertion rather than quietly
    /// degrading the layer.
    pub fn new(lut: &[u8; 256], gamma: f64, bit_depth: u32) -> Self {
        debug_assert!(
            (2..=7).contains(&bit_depth),
            "dither bit depth {bit_depth} is outside the 2..=7 range dithering is defined for",
        );
        let bit_depth = bit_depth.clamp(2, 7);
        let mut source_energy = [0.0f32; 256];
        for i in 0..256 {
            source_energy[i] = ((lut[i] as f64) / 255.0).powf(gamma) as f32;
        }

        let levels = 1 << bit_depth;
        let mut target_bytes = Vec::with_capacity(levels);
        let mut target_energy = Vec::with_capacity(levels);
        for i in 0..levels {
            let val = i as f64 * (255.0 / (levels - 1) as f64);
            let pwm_byte = val.round().clamp(0.0, 255.0) as u8;
            target_bytes.push(pwm_byte);
            target_energy.push(((pwm_byte as f64) / 255.0).powf(gamma) as f32);
        }

        // --- Precompute 1D Binned Dither-LUT ---
        let mut bin_bytes = [0u8; 4096];
        let mut bin_energy = [0.0f32; 4096];

        let min_e = -0.5f32;
        let span_e = 2.0f32;

        for bin_idx in 0..4096 {
            // Reconstruct the desired energy at the center of the bin:
            let desired_energy = min_e + (bin_idx as f32 + 0.5) / 4096.0 * span_e;

            // Find the closest target palette index
            let mut best_idx = 0;
            let mut min_diff = f32::MAX;
            for (k, &tgt_energy) in target_energy.iter().enumerate() {
                let diff = (desired_energy - tgt_energy).abs();
                if diff < min_diff {
                    min_diff = diff;
                    best_idx = k;
                }
            }

            bin_bytes[bin_idx] = target_bytes[best_idx];
            bin_energy[bin_idx] = target_energy[best_idx];
        }

        Self {
            source_energy,
            target_bytes,
            target_energy,
            bin_bytes,
            bin_energy,
        }
    }
}

/// True when a zero pixel carrying no error dithers to zero and emits no error.
///
/// Every skip in [`dither_rle_layer_with_lut_and_gamma`] rests on this: empty
/// space must consume error without ever creating any.  It holds for an identity
/// or zero-preserving LUT, but a tail-cure LUT is free to map input 0 onto a cure
/// value, and then empty space is not empty and the whole frame has to be walked.
/// Checked rather than assumed.
fn zero_is_inert(palette: &DitherPaletteV3) -> bool {
    if palette.source_energy[0] != 0.0 {
        return false;
    }
    let bin = (((0.0f32 - MIN_ENERGY) * ENERGY_SCALE).clamp(0.0, 4095.0)) as usize;
    palette.bin_bytes[bin] == 0 && palette.bin_energy[bin] == 0.0
}

/// Dither an RLE layer, walking only the part of the frame that can affect the
/// output.
///
/// Floyd-Steinberg is a strict left-to-right, top-to-bottom dependency chain, so
/// the obvious implementation walks every pixel of the plate — on a 16K printer
/// that is 15120 columns for a row the model touches in a few hundred, and it
/// dominated every slicing profile we took (74-82% of all CPU).
///
/// The walk is restricted to a band without changing a single output byte. In
/// empty space the desired energy is exactly 0, which lands in the bin whose
/// target energy is exactly 0, so the quantisation error is exactly `0.0` and
/// nothing propagates: the band closes itself rather than being cut off at some
/// guessed margin. The band still grows rightward for as long as the error is a
/// non-zero float, so a genuine bleed is followed to its end.
pub fn dither_rle_layer_with_lut_and_gamma(
    runs: &[RleRun],
    palette: &DitherPaletteV3,
    width: usize,
    height: usize,
) -> Vec<RleRun> {
    if runs.is_empty() || width == 0 || height == 0 {
        return Vec::new();
    }

    let Some((min_x, max_x, min_y, max_y)) =
        crate::engine::nonzero_bounds_from_rle_runs(runs, width, height)
    else {
        let mut out = RleAccum::new();
        emit_zero_rows(&mut out, height, width);
        return out.finish();
    };

    if !zero_is_inert(palette) {
        return dither_rle_layer_full_frame(runs, palette, width, height);
    }

    let mut out = RleAccum::new();
    let mut err_curr = vec![0.0f32; width];
    let mut err_next = vec![0.0f32; width];
    let mut row_pixels = vec![0u8; width];
    let mut decoder = crate::engine::RleRowDecoder::new(runs);

    // Rows above the model hold nothing and no error has been produced yet.
    emit_zero_rows(&mut out, min_y, width);
    decoder.skip_pixels(min_y.saturating_mul(width));

    // Columns of `err_curr` that may hold a non-zero value; empty when lo > hi.
    let mut curr_lo = usize::MAX;
    let mut curr_hi = 0usize;

    for y in min_y..height {
        let has_content = y <= max_y;
        let content_empty = !has_content;
        let err_empty = curr_lo > curr_hi;

        if content_empty && err_empty {
            // Nothing lit and nothing carried: every remaining row is blank.
            emit_zero_rows(&mut out, height - y, width);
            break;
        }

        let mut lo = if content_empty { curr_lo } else { min_x.min(curr_lo) };
        let mut hi = if content_empty { curr_hi } else { max_x.max(curr_hi) };
        lo = lo.min(width - 1);
        hi = hi.min(width - 1);

        if has_content {
            let decode_hi = max_x.max(lo);
            decoder.decode_next_row_span(width, lo, &mut row_pixels[lo..=decode_hi]);
        }

        let mut x = lo;
        while x <= hi {
            // Past the model's last lit column there is nothing left to read;
            // only carried error is in play.
            let val = if has_content && x <= max_x {
                row_pixels[x]
            } else {
                0
            };
            let desired = palette.source_energy[val as usize] + err_curr[x];
            let bin = (((desired - MIN_ENERGY) * ENERGY_SCALE).clamp(0.0, 4095.0)) as usize;
            row_pixels[x] = palette.bin_bytes[bin];
            let quant_error = desired - palette.bin_energy[bin];

            if quant_error != 0.0 {
                if x + 1 < width {
                    err_curr[x + 1] += quant_error * 0.4375; // right, 7/16
                    if x + 1 > hi {
                        hi = x + 1; // the bleed is still alive; follow it
                    }
                }
                if y + 1 < height {
                    if x > 0 {
                        err_next[x - 1] += quant_error * 0.1875; // below-left, 3/16
                    }
                    err_next[x] += quant_error * 0.3125; // below, 5/16
                    if x + 1 < width {
                        err_next[x + 1] += quant_error * 0.0625; // below-right, 1/16
                    }
                }
            }
            x += 1;
        }

        out.push_run(lo as u32, 0);
        emit_row(&mut out, &row_pixels[lo..=hi]);
        out.push_run((width - 1 - hi) as u32, 0);

        // `err_next` was written across [lo-1, hi+1]; that becomes the new carry.
        let next_lo = lo.saturating_sub(1);
        let next_hi = (hi + 1).min(width - 1);
        std::mem::swap(&mut err_curr, &mut err_next);
        // The row consumed [lo, hi] of the old `err_curr` and also wrote into it
        // rightward as it went, out to hi+1 — clearing only what was carried in
        // leaves that tail dirty for the row after next.
        err_next[lo..=next_hi].fill(0.0);
        if y + 1 < height {
            curr_lo = next_lo;
            curr_hi = next_hi;
        } else {
            curr_lo = usize::MAX;
            curr_hi = 0;
        }
    }

    out.finish()
}

/// The unbounded walk, kept for jobs whose LUT cures at input 0 — and used as the
/// oracle the bounded implementation is tested against.
fn dither_rle_layer_full_frame(
    runs: &[RleRun],
    palette: &DitherPaletteV3,
    width: usize,
    height: usize,
) -> Vec<RleRun> {
    if runs.is_empty() || width == 0 || height == 0 {
        return Vec::new();
    }

    let mut out = RleAccum::new();
    
    // Auxiliary sliding row error buffers: only O(width) RAM overhead
    let mut err_curr = vec![0.0f32; width];
    let mut err_next = vec![0.0f32; width];

    let mut decoder = crate::engine::RleRowDecoder::new(runs);
    let mut row_pixels = vec![0u8; width];

    // Binned lookup constants
    let min_e = -0.5f32;
    let scale = 2047.5f32; // maps span of 2.0 to index range 0..4095

    for y in 0..height {
        // Decode one row from RLE runs
        decoder.decode_next_row_span(width, 0, &mut row_pixels);

        let is_empty_row = row_pixels.iter().all(|&v| v == 0);
        let has_prior_errors = err_curr.iter().any(|&e| e != 0.0);

        if is_empty_row && !has_prior_errors {
            // Fast path: emit empty row directly
            emit_zero_rows(&mut out, 1, width);
            err_curr.fill(0.0);
            err_next.fill(0.0);
            continue;
        }

        // Apply Floyd-Steinberg error diffusion on the row with O(1) lookup.
        // Peel the first iteration (x = 0) and last iteration (x = width - 1)
        // to eliminate coordinate boundary checks in the hot inner loop.
        if width > 0 {
            let x = 0;
            let val = row_pixels[x];
            let src_energy = palette.source_energy[val as usize];
            let desired_energy = src_energy + err_curr[x];
            let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
            let dithered_val = palette.bin_bytes[bin_idx];
            row_pixels[x] = dithered_val;
            let quant_error = desired_energy - palette.bin_energy[bin_idx];

            if width > 1 {
                err_curr[1] += quant_error * 0.4375; // Right (7/16)
            }
            if y + 1 < height {
                err_next[0] += quant_error * 0.3125; // Bottom (5/16)
                if width > 1 {
                    err_next[1] += quant_error * 0.0625; // Bottom-Right (1/16)
                }
            }
        }

        if y + 1 < height {
            for x in 1..(width.saturating_sub(1)) {
                let val = row_pixels[x];
                let src_energy = palette.source_energy[val as usize];
                let desired_energy = src_energy + err_curr[x];
                let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
                let dithered_val = palette.bin_bytes[bin_idx];
                row_pixels[x] = dithered_val;
                let quant_error = desired_energy - palette.bin_energy[bin_idx];

                err_curr[x + 1] += quant_error * 0.4375; // Right (7/16)
                err_next[x - 1] += quant_error * 0.1875; // Bottom-Left (3/16)
                err_next[x] += quant_error * 0.3125;     // Bottom (5/16)
                err_next[x + 1] += quant_error * 0.0625; // Bottom-Right (1/16)
            }
        } else {
            for x in 1..(width.saturating_sub(1)) {
                let val = row_pixels[x];
                let src_energy = palette.source_energy[val as usize];
                let desired_energy = src_energy + err_curr[x];
                let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
                let dithered_val = palette.bin_bytes[bin_idx];
                row_pixels[x] = dithered_val;
                let quant_error = desired_energy - palette.bin_energy[bin_idx];

                err_curr[x + 1] += quant_error * 0.4375; // Right (7/16)
            }
        }

        if width > 1 {
            let x = width - 1;
            let val = row_pixels[x];
            let src_energy = palette.source_energy[val as usize];
            let desired_energy = src_energy + err_curr[x];
            let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
            let dithered_val = palette.bin_bytes[bin_idx];
            row_pixels[x] = dithered_val;
            let quant_error = desired_energy - palette.bin_energy[bin_idx];

            if y + 1 < height {
                err_next[x - 1] += quant_error * 0.1875; // Bottom-Left (3/16)
                err_next[x] += quant_error * 0.3125;     // Bottom (5/16)
            }
        }

        // Re-encode dithered row to RLE runs
        emit_row(&mut out, &row_pixels);

        // Swap error rows & clear err_next for next loop
        std::mem::swap(&mut err_curr, &mut err_next);
        err_next.fill(0.0);
    }

    out.finish()
}

/// Dither a flat mask sub-image row-by-row with O(width) auxiliary memory and O(1) binned lookup table.
///
/// Implements sequential Floyd-Steinberg error diffusion in physical energy space
/// directly in the provided flat slice bounds.
pub fn dither_mask_in_bounds(
    mask: &mut [u8],
    row_width: usize,
    row_height: usize,
    palette: &DitherPaletteV3,
) {
    if mask.is_empty() || row_width == 0 || row_height == 0 {
        return;
    }

    // Auxiliary sliding row error buffers: only O(row_width) RAM overhead
    let mut err_curr = vec![0.0f32; row_width];
    let mut err_next = vec![0.0f32; row_width];

    // Binned lookup constants
    let min_e = -0.5f32;
    let scale = 2047.5f32; // maps span of 2.0 to index range 0..4095

    for y in 0..row_height {
        let row_offset = y * row_width;
        
        // Peel the first iteration (x = 0) and last iteration (x = row_width - 1)
        // to eliminate coordinate boundary checks in the hot inner loop.
        if row_width > 0 {
            let x = 0;
            let idx = row_offset + x;
            let val = mask[idx];
            let src_energy = palette.source_energy[val as usize];
            let desired_energy = src_energy + err_curr[x];
            let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
            let dithered_val = palette.bin_bytes[bin_idx];
            mask[idx] = dithered_val;
            let quant_error = desired_energy - palette.bin_energy[bin_idx];

            if row_width > 1 {
                err_curr[1] += quant_error * 0.4375; // Right (7/16)
            }
            if y + 1 < row_height {
                err_next[0] += quant_error * 0.3125; // Bottom (5/16)
                if row_width > 1 {
                    err_next[1] += quant_error * 0.0625; // Bottom-Right (1/16)
                }
            }
        }

        if y + 1 < row_height {
            for x in 1..(row_width.saturating_sub(1)) {
                let idx = row_offset + x;
                let val = mask[idx];
                let src_energy = palette.source_energy[val as usize];
                let desired_energy = src_energy + err_curr[x];
                let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
                let dithered_val = palette.bin_bytes[bin_idx];
                mask[idx] = dithered_val;
                let quant_error = desired_energy - palette.bin_energy[bin_idx];

                err_curr[x + 1] += quant_error * 0.4375; // Right (7/16)
                err_next[x - 1] += quant_error * 0.1875; // Bottom-Left (3/16)
                err_next[x] += quant_error * 0.3125;     // Bottom (5/16)
                err_next[x + 1] += quant_error * 0.0625; // Bottom-Right (1/16)
            }
        } else {
            for x in 1..(row_width.saturating_sub(1)) {
                let idx = row_offset + x;
                let val = mask[idx];
                let src_energy = palette.source_energy[val as usize];
                let desired_energy = src_energy + err_curr[x];
                let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
                let dithered_val = palette.bin_bytes[bin_idx];
                mask[idx] = dithered_val;
                let quant_error = desired_energy - palette.bin_energy[bin_idx];

                err_curr[x + 1] += quant_error * 0.4375; // Right (7/16)
            }
        }

        if row_width > 1 {
            let x = row_width - 1;
            let idx = row_offset + x;
            let val = mask[idx];
            let src_energy = palette.source_energy[val as usize];
            let desired_energy = src_energy + err_curr[x];
            let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
            let dithered_val = palette.bin_bytes[bin_idx];
            mask[idx] = dithered_val;
            let quant_error = desired_energy - palette.bin_energy[bin_idx];

            if y + 1 < row_height {
                err_next[x - 1] += quant_error * 0.1875; // Bottom-Left (3/16)
                err_next[x] += quant_error * 0.3125;     // Bottom (5/16)
            }
        }

        // Swap error rows & clear err_next for next loop
        std::mem::swap(&mut err_curr, &mut err_next);
        err_next.fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rle::RleRun;

    #[test]
    fn test_dither_palette_new() {
        let mut lut = [0u8; 256];
        for i in 0..256 {
            lut[i] = i as u8;
        }

        // Test 3-bit (8 levels) palette with gamma 3.0
        let palette = DitherPaletteV3::new(&lut, 3.0, 3);
        assert_eq!(palette.target_bytes.len(), 8);
        assert_eq!(palette.target_energy.len(), 8);

        // Target bytes should be linearly spaced PWM values from 0 to 255:
        // 0, 36, 73, 109, 146, 182, 219, 255
        let expected_bytes = vec![0, 36, 73, 109, 146, 182, 219, 255];
        assert_eq!(palette.target_bytes, expected_bytes);

        // Check source energy for value 128: (128/255)^3 = 0.126
        let err = (palette.source_energy[128] - (128.0 / 255.0f32).powi(3)).abs();
        assert!(err < 1e-5);
    }

    #[test]
    fn test_dither_rle_layer_all_palette_values() {
        let mut lut = [0u8; 256];
        for i in 0..256 {
            lut[i] = i as u8;
        }
        let palette = DitherPaletteV3::new(&lut, 3.0, 3);

        // Let's create an input layer with a gradient:
        // runs: 16 runs of value 128 (gray)
        let runs = vec![RleRun { value: 128, length: 16 }];
        let dithered = dither_rle_layer_with_lut_and_gamma(&runs, &palette, 4, 4);

        // Decode dithered to see that all pixels are in target_bytes palette!
        let mut decoder = crate::engine::RleRowDecoder::new(&dithered);
        let mut row = vec![0u8; 4];
        for _ in 0..4 {
            decoder.decode_next_row_span(4, 0, &mut row);
            for &val in &row {
                assert!(palette.target_bytes.contains(&val));
            }
        }
    }

    #[test]
    fn test_dither_mask_in_bounds() {
        let mut lut = [0u8; 256];
        for i in 0..256 {
            lut[i] = i as u8;
        }
        let palette = DitherPaletteV3::new(&lut, 3.0, 3);

        // Create a 4x4 flat gray mask
        let mut mask = vec![128u8; 16];
        dither_mask_in_bounds(&mut mask, 4, 4, &palette);

        // All values in mask must be from target_bytes
        for &val in &mask {
            assert!(palette.target_bytes.contains(&val));
        }

        // Output should have diffuse/error propagation (not just a flat color because 128 is not in target_bytes)
        let first_val = mask[0];
        let mut flat = true;
        for &val in &mask {
            if val != first_val {
                flat = false;
                break;
            }
        }
        assert!(!flat, "The dithered output should contain spatially distributed values rather than a single flat level");
    }

    /// Build runs from a flat pixel buffer.
    fn runs_of(pixels: &[u8]) -> Vec<RleRun> {
        let mut acc = RleAccum::new();
        emit_row(&mut acc, pixels);
        acc.finish()
    }

    fn identity_palette(bit_depth: u32) -> DitherPaletteV3 {
        let mut lut = [0u8; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = i as u8;
        }
        DitherPaletteV3::new(&lut, 2.2, bit_depth)
    }

    /// The bounded walk must return byte-identical runs to the full-frame walk.
    ///
    /// This is the whole safety argument for skipping empty space, so it is
    /// asserted on patterns chosen to stress the skip: content pinned to each
    /// edge, a lone lit pixel whose error has nowhere to go, and a gradient that
    /// deliberately bleeds sideways.
    fn assert_bounded_matches_full_frame(
        name: &str,
        pixels: &[u8],
        width: usize,
        height: usize,
        bit_depth: u32,
    ) {
        assert_eq!(pixels.len(), width * height, "{name}: bad fixture");
        let palette = identity_palette(bit_depth);
        let runs = runs_of(pixels);
        let bounded = dither_rle_layer_with_lut_and_gamma(&runs, &palette, width, height);
        let reference = dither_rle_layer_full_frame(&runs, &palette, width, height);
        assert_eq!(bounded, reference, "{name}: bounded walk changed the output");
        assert_eq!(
            bounded.iter().map(|r| r.length as usize).sum::<usize>(),
            width * height,
            "{name}: wrong pixel count"
        );
    }

    #[test]
    fn bounded_walk_is_identical_for_a_small_block_in_a_wide_frame() {
        let (w, h) = (256usize, 24usize);
        let mut px = vec![0u8; w * h];
        for y in 8..14 {
            for x in 100..118 {
                px[y * w + x] = 137;
            }
        }
        assert_bounded_matches_full_frame("block", &px, w, h, 3);
    }

    #[test]
    fn bounded_walk_is_identical_for_a_bleeding_gradient() {
        // Mid grays quantise badly on purpose: the error has to travel.
        let (w, h) = (300usize, 40usize);
        let mut px = vec![0u8; w * h];
        for y in 5..35 {
            for x in 60..200 {
                px[y * w + x] = ((x - 60) * 255 / 140) as u8;
            }
        }
        assert_bounded_matches_full_frame("gradient", &px, w, h, 3);
    }

    #[test]
    fn bounded_walk_is_identical_for_a_single_lit_pixel() {
        let (w, h) = (128usize, 16usize);
        let mut px = vec![0u8; w * h];
        px[4 * w + 31] = 200;
        assert_bounded_matches_full_frame("single pixel", &px, w, h, 3);
    }

    #[test]
    fn bounded_walk_is_identical_when_content_touches_the_edges() {
        let (w, h) = (96usize, 12usize);

        let mut left = vec![0u8; w * h];
        for y in 0..4 {
            for x in 0..6 {
                left[y * w + x] = 90;
            }
        }
        assert_bounded_matches_full_frame("top-left corner", &left, w, h, 3);

        let mut right = vec![0u8; w * h];
        for y in (h - 4)..h {
            for x in (w - 6)..w {
                right[y * w + x] = 90;
            }
        }
        assert_bounded_matches_full_frame("bottom-right corner", &right, w, h, 3);

        assert_bounded_matches_full_frame("full frame", &vec![170u8; w * h], w, h, 3);
    }

    /// A rectangle is the one shape whose bounding box costs nothing, so it
    /// proves the least. These are the shapes the band actually has to reason
    /// about: one that narrows to a point, one with a gap the walk must cross
    /// and hand back as zeros, and one that is a single pixel per row.
    #[test]
    fn bounded_walk_is_identical_for_shapes_that_are_not_rectangles() {
        let (w, h) = (240usize, 48usize);

        // Diamond: every row a different span, narrowing to a point at both ends.
        let mut diamond = vec![0u8; w * h];
        let (cx, cy) = (120i32, 24i32);
        for y in 0..h {
            for x in 0..w {
                let d = (x as i32 - cx).abs() + (y as i32 - cy).abs();
                if d < 20 {
                    diamond[y * w + x] = (255 - d * 6) as u8;
                }
            }
        }
        assert_bounded_matches_full_frame("diamond", &diamond, w, h, 3);

        // Two islands far apart: the band has to span the gap between them, and
        // the gap must come back out as zeros.
        let mut islands = vec![0u8; w * h];
        for y in 10..30 {
            for x in 12..26 {
                islands[y * w + x] = 180;
            }
            for x in 200..214 {
                islands[y * w + x] = 90;
            }
        }
        assert_bounded_matches_full_frame("two islands", &islands, w, h, 3);

        // A diagonal sliver: one or two lit pixels per row, marching sideways.
        let mut sliver = vec![0u8; w * h];
        for y in 0..h {
            let x = 4 + y * 4;
            if x < w {
                sliver[y * w + x] = 220;
            }
        }
        assert_bounded_matches_full_frame("diagonal sliver", &sliver, w, h, 3);
    }

    #[test]
    fn bounded_walk_is_identical_across_bit_depths() {
        let (w, h) = (200usize, 20usize);
        let mut px = vec![0u8; w * h];
        for y in 3..17 {
            for x in 40..90 {
                px[y * w + x] = (((x * 7 + y * 13) % 256) as u8).max(1);
            }
        }
        for bits in [2u32, 3, 4, 6] {
            assert_bounded_matches_full_frame(&format!("{bits}-bit"), &px, w, h, bits);
        }
    }

    /// A LUT that cures at input 0 makes empty space non-empty; the bounded walk
    /// must recognise that and fall back rather than skip real output away.
    #[test]
    fn a_lut_that_cures_at_zero_disables_the_skip() {
        let mut lut = [40u8; 256];
        for (i, v) in lut.iter_mut().enumerate().skip(1) {
            *v = (*v).max(i as u8);
        }
        let palette = DitherPaletteV3::new(&lut, 2.2, 3);
        assert!(!zero_is_inert(&palette), "a curing LUT must not be treated as inert");

        let (w, h) = (64usize, 8usize);
        let mut px = vec![0u8; w * h];
        px[2 * w + 10] = 200;
        let runs = runs_of(&px);
        let bounded = dither_rle_layer_with_lut_and_gamma(&runs, &palette, w, h);
        let reference = dither_rle_layer_full_frame(&runs, &palette, w, h);
        assert_eq!(bounded, reference);
        assert!(
            bounded.iter().any(|r| r.value != 0),
            "a curing LUT must still light empty space"
        );
    }

    /// An empty layer must dither to nothing at all.
    ///
    /// This is the invariant that makes it legal to skip empty regions: with
    /// `src = 0` and no incoming error the desired energy is 0, which lands in
    /// the bin whose target energy is exactly 0, so the quantisation error is 0
    /// and nothing is propagated onwards.  Empty space consumes error but never
    /// creates it.
    #[test]
    fn empty_layer_dithers_to_nothing() {
        let mut lut = [0u8; 256];
        for i in 0..256 {
            lut[i] = i as u8;
        }
        let palette = DitherPaletteV3::new(&lut, 2.2, 3);

        let (width, height) = (64usize, 8usize);
        let input = vec![RleRun { length: (width * height) as u32, value: 0 }];
        let out = dither_rle_layer_with_lut_and_gamma(&input, &palette, width, height);

        assert!(
            out.iter().all(|run| run.value == 0),
            "an empty layer produced non-zero output: {out:?}"
        );
        assert_eq!(
            out.iter().map(|run| run.length as usize).sum::<usize>(),
            width * height,
            "output pixel count must match the layer"
        );
    }
}
