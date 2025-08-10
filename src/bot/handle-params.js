export function handleParams(url) {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    return {
        text: params.get('search_text') || '',
        catalog: params.getAll('catalog[]').join(',') || '',
        min: params.get('price_from') || '',
        max: params.get('price_to') || '',
        currency: params.get('currency') || '',
        size: params.getAll('size_ids[]').join(',') || '',
        brand: params.getAll('brand_ids[]').join(',') || '',
        status: params.getAll('status_ids[]').join(',') || '',
        colour: params.getAll('color_ids[]').join(',') || '',
        material: params.getAll('material_ids[]').join(',') || '',
    };
}
