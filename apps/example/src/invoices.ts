import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { resolveScope, type AxedaExpress } from '@teamblind/axeda-express';

export interface Invoice {
  readonly id: string;
  readonly companyId: string;
  readonly businessId: string | null;
  readonly customer: string;
  readonly amount: number;
}

/** El cuerpo de una petición es lo que el cliente quiera: lista blanca y límites. */
const newInvoice = z.strictObject({
  customer: z.string().trim().min(1).max(200),
  amount: z.number().int().min(1).max(1_000_000_000),
});

const inCompany = resolveScope({ company: 'companyId' });
const inBusiness = resolveScope({ company: 'companyId', business: 'businessId' });

/**
 * Facturas de ejemplo (en memoria; en tu aplicación, tu base de datos). Muestra los cuatro
 * patrones que se repiten al proteger rutas con Axeda:
 *
 * 1. **Permiso en la compañía de la ruta** → `requirePermission(permiso, { scope })`.
 * 2. **Permiso en un negocio** → el negocio debe ser de la compañía que dice la ruta.
 * 3. **Listados** → `scopeFilter` dice dónde tiene el permiso; tu consulta se filtra con eso.
 * 4. **Un recurso concreto** → además del permiso, se comprueba que el recurso sea de ESA
 *    compañía; si no, cualquiera con permiso en su compañía podría tocar el de otra por su `id`.
 */
export function invoiceRoutes(x: AxedaExpress): Router {
  const invoices = new Map<string, Invoice>();
  const router = Router();

  // 3. Todas las facturas que la persona puede ver, en cualquier compañía o negocio.
  router.get('/invoices', x.requireAuth(), async (request, response) => {
    const where = await x.scopeFilter(request, 'invoice:read');
    const visible = [...invoices.values()].filter(
      (invoice) =>
        where.unrestricted ||
        where.companyIds.includes(invoice.companyId) ||
        (invoice.businessId !== null && where.businessIds.includes(invoice.businessId)),
    );
    response.json({ items: visible });
  });

  // 1. Las de una compañía.
  router.get(
    '/companies/:companyId/invoices',
    x.requirePermission('invoice:read', { scope: inCompany }),
    (request, response) => {
      const companyId = String(request.params['companyId']);
      response.json({
        items: [...invoices.values()].filter((invoice) => invoice.companyId === companyId),
      });
    },
  );

  router.post(
    '/companies/:companyId/invoices',
    x.requirePermission('invoice:create', { scope: inCompany }),
    (request, response) => {
      const body = newInvoice.safeParse(request.body);
      if (!body.success) {
        response.status(400).json({ code: 'INVALID_INPUT', message: 'Invalid invoice.' });
        return;
      }
      const invoice: Invoice = {
        id: randomUUID(),
        companyId: String(request.params['companyId']),
        businessId: null,
        ...body.data,
      };
      invoices.set(invoice.id, invoice);
      response.status(201).json(invoice);
    },
  );

  // 2. De un negocio: Axeda lee de la base de datos de qué compañía es.
  router.post(
    '/companies/:companyId/businesses/:businessId/invoices',
    x.requirePermission('invoice:create', { scope: inBusiness }),
    (request, response) => {
      const body = newInvoice.safeParse(request.body);
      if (!body.success) {
        response.status(400).json({ code: 'INVALID_INPUT', message: 'Invalid invoice.' });
        return;
      }
      const invoice: Invoice = {
        id: randomUUID(),
        companyId: String(request.params['companyId']),
        businessId: String(request.params['businessId']),
        ...body.data,
      };
      invoices.set(invoice.id, invoice);
      response.status(201).json(invoice);
    },
  );

  // 4. Un recurso concreto.
  router.delete(
    '/companies/:companyId/invoices/:invoiceId',
    x.requirePermission('invoice:delete', { scope: inCompany }),
    (request, response) => {
      const invoice = invoices.get(String(request.params['invoiceId']));
      if (invoice?.companyId !== String(request.params['companyId'])) {
        // Misma respuesta si no existe o es de otra compañía.
        response.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' });
        return;
      }
      invoices.delete(invoice.id);
      response.status(204).end();
    },
  );

  return router;
}
