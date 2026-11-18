import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import { IMAGE_CONTENT_TYPES, IMAGE_PURPOSES } from '@teamblind/axeda-core';
import { toImageDto, toImageUploadDto } from './dto.js';
import { access, id, run, type CoreProvider } from './endpoints.js';

const purpose = z.enum(IMAGE_PURPOSES);
const target = { purpose, targetId: id };
/** El permiso de cada imagen es el de editar su entidad, comprobado en ella. */
const REQUIRES =
  'the permission that edits the entity (axeda:company|business|site:manage); for user.avatar, the person or axeda:user:manage';

/**
 * Logos, favicons y fotos de perfil. El navegador sube el archivo directo al almacén con la URL
 * firmada: aquí solo se pide la subida, se completa (Axeda comprueba lo subido) o se quita.
 */
export function createImageEndpoints(core: CoreProvider) {
  return {
    axedaImageUpload: createAuthEndpoint(
      '/axeda/image/upload',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({
          ...target,
          contentType: z.enum(IMAGE_CONTENT_TYPES),
          size: z.number().int().min(1),
        }),
        metadata: access(REQUIRES, 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toImageUploadDto(await axeda.images.createUpload(actor, ctx.body))),
        ),
    ),

    axedaImageComplete: createAuthEndpoint(
      '/axeda/image/complete',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ uploadId: id }),
        metadata: access('(authenticated; only the person who asked for the upload)', 'own'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toImageDto(await axeda.images.completeUpload(actor, ctx.body.uploadId))),
        ),
    ),

    axedaImageRemove: createAuthEndpoint(
      '/axeda/image/remove',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject(target),
        metadata: access(REQUIRES, 'per-target'),
      },
      (ctx) =>
        run(ctx, core, async (axeda, actor) =>
          ctx.json(toImageDto(await axeda.images.remove(actor, ctx.body))),
        ),
    ),
  };
}
