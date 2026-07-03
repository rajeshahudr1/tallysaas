'use strict';

/**
 * api/Controllers/Tenant/ProductImageController.js
 *
 * Product image gallery (multi-image, local disk). Every response carries the
 * ABSOLUTE url (via Helpers/uploads.fullUrl) so web + app never build paths.
 *   list   GET    /products/:id/images
 *   upload POST   /products/:id/images        (multipart, field `images`)
 *   remove DELETE /products/:id/images/:imageId
 * Not synced to Tally (Tally has no stock-item image).
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { fullUrl, deleteFile } = require('../../Helpers/uploads');

const OOPS = 'Oops..Something went wrong. Please try again.';

const toDto = (req, r) => ({ id: r.id, url: fullUrl(req, r.file_path), name: r.original_name, sort_order: r.sort_order });

async function list(req, res) {
    try {
        const productId = Number(req.params.id);
        const rows = await db('product_images')
            .where({ company_id: req.companyId, product_id: productId }).whereNull('deleted_at')
            .orderBy('sort_order', 'asc').orderBy('id', 'asc')
            .select('id', 'file_path', 'original_name', 'sort_order');
        return R.successResponse(res, { data: rows.map((r) => toDto(req, r)) });
    } catch (err) {
        console.error('productImages.list error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function upload(req, res) {
    try {
        const productId = Number(req.params.id);
        const prod = await db('products').where({ id: productId, company_id: req.companyId }).whereNull('deleted_at').first('id');
        if (!prod) return R.errorResponse(res, 'Product not found.', 404);

        const files = Array.isArray(req.files) ? req.files : [];
        if (!files.length) return R.errorResponse(res, 'No images uploaded.', 422);

        const maxRow = await db('product_images')
            .where({ company_id: req.companyId, product_id: productId }).whereNull('deleted_at')
            .max('sort_order as m').first();
        let sort = (maxRow && maxRow.m != null) ? Number(maxRow.m) : -1;

        const rows = files.map((f) => {
            sort += 1;
            return {
                company_id:    req.companyId,
                product_id:    productId,
                file_path:     `products/${req.companyId}/${f.filename}`,   // relative to /uploads
                original_name: (f.originalname || '').slice(0, 191),
                size_bytes:    f.size,
                mime:          f.mimetype,
                sort_order:    sort,
                created_by:    req.user ? req.user.sub : null,
            };
        });
        const inserted = await db('product_images').insert(rows)
            .returning(['id', 'file_path', 'original_name', 'sort_order']);
        return R.successResponse(res, { data: inserted.map((r) => toDto(req, r)) }, `${inserted.length} image(s) uploaded.`);
    } catch (err) {
        console.error('productImages.upload error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function remove(req, res) {
    try {
        const productId = Number(req.params.id);
        const imageId = Number(req.params.imageId);
        const img = await db('product_images')
            .where({ id: imageId, company_id: req.companyId, product_id: productId }).whereNull('deleted_at').first();
        if (!img) return R.errorResponse(res, 'Image not found.', 404);
        await db('product_images').where('id', imageId).update({ deleted_at: new Date(), updated_at: new Date() });
        deleteFile(img.file_path);
        return R.successResponse(res, { id: imageId }, 'Image removed.');
    } catch (err) {
        console.error('productImages.remove error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { list, upload, remove };
