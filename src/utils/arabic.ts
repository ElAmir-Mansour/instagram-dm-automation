/**
/**
 * Normalizes Arabic text to strip variations in spelling of common characters
 * (Hamzas, Teh Marbuta, Yeh, diacritics/tashkeel) for robust keyword matching.
 */
export function normalizeArabic(text: string): string {
    if (!text) return '';
    return text
        .toLowerCase()
        // Replace various forms of Alef with a bare Alef
        .replace(/[أإآ]/g, 'ا')
        // Replace Teh Marbuta with Heh
        .replace(/ة/g, 'ه')
        // Replace Yeh/Alef Maksura with bare Yeh
        .replace(/[ىي]/g, 'ي')
        // Remove diacritics (Fatha, Damma, Kasra, Shadda, Sukun, Tanween)
        .replace(/[\u064B-\u0652]/g, '')
        // Clean multiple whitespaces and trim
        .replace(/\s+/g, ' ')
        .trim();
}
