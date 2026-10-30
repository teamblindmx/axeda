# Seguridad

Reporta las vulnerabilidades en privado: consulta [SECURITY.md](../../SECURITY.md). No abras un
issue público.

## Qué garantiza Axeda

Cada una tiene pruebas, y las más delicadas se comprobaron rompiendo la regla a propósito para
confirmar que una prueba falla.

| Garantía                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Denegar por defecto.** Sin asignación, no hay acceso. Un permiso desconocido es un error, no un «no»                                                    |
| **Aislamiento entre compañías.** Una función en una compañía nunca llega a otra; la compañía de un negocio sale de la base de datos, nunca de la petición |
| **Sin escalada.** Nadie puede conceder, editar ni bloquear para subir por encima de su propio nivel                                                       |
| **Revocación inmediata.** La siguiente petición tras revocar se deniega, en cada instancia                                                                |
| **Autorizar antes de revelar.** Una petición rechazada recibe la misma respuesta con un id real que con uno inventado                                     |
| **El bloqueo es total.** Un usuario bloqueado no abre sesión, pierde las abiertas y no tiene permiso por ninguna vía                                      |
| **Sin manejo de contraseñas.** Axeda nunca ve, fija ni guarda una contraseña                                                                              |
| **Respuestas por lista blanca.** Cada endpoint devuelve una forma declarada; una columna que añadas a `user` no se filtra                                 |
| **Atómico donde importa.** Versiones, contadores y cierres de un solo uso usan operaciones atómicas de la base                                            |
| **Nada se guarda en cachés.** Toda respuesta de `/axeda/*`, errores incluidos, lleva `Cache-Control: no-store`                                            |
| **Auditoría.** Las acciones administrativas y las denegaciones se añaden a un registro                                                                    |
| **Falla cerrando.** Un fallo al comprobar un permiso rechaza la petición; los errores internos llegan al cliente como un `500` genérico                   |

## Qué fija `secureAuthOptions()`

```ts
betterAuth({
  ...secureAuthOptions({ baseURL, secret, trustedOrigins }),
  database,
  plugins: [axedaPlugin],
});
```

| Ajuste                          | Valor                                                                  | Por qué                                                            |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `trustedOrigins`                | Lista explícita, normalizada                                           | Decide qué sitios pueden llamar con cookie y recibir redirecciones |
| Cookies                         | `HttpOnly`, `SameSite=Lax`, `Secure` en producción                     | Los scripts no las leen; se limita el envío entre sitios           |
| Contraseñas                     | De 12 a 128 caracteres                                                 | La longitud pesa más que las reglas de composición                 |
| Verificación de correo          | Obligatoria                                                            | Las invitaciones dependen de un correo verificado                  |
| Restablecer contraseña          | Cierra todas las sesiones                                              | Una sesión robada no sobrevive al restablecimiento                 |
| Sesiones                        | 7 días, renovadas a diario, 15 minutos «frescas»                       | Exposición acotada                                                 |
| Caché de cookie de sesión       | Apagada                                                                | Una sesión o permiso revocado seguiría vigente                     |
| Comprobaciones CSRF y de origen | Activas                                                                | Los endpoints de Axeda se autentican con cookie                    |
| Límites de peticiones           | Activos; inicio de sesión 5/min, registro 5/5 min, restablecer 3/5 min | Frenan los intentos y el abuso, por dirección                      |

**Se niega a devolver** una configuración débil: un secreto de menos de 32 caracteres o con menos
de 8 caracteres distintos, un origen con comodín, un origen con ruta, `http` fuera de `localhost`,
o `requireEmailVerification: false` en producción. A su vez, el plugin de Axeda se niega a
arrancar si `session.cookieCache`, `advanced.disableCSRFCheck`, `advanced.disableOriginCheck` o
`advanced.ipAddress.disableIpTracking` están activos.

**Detrás de un proxy inverso,** pasa `trustedProxies` (IP o CIDR). Sin él, Better Auth solo confía
en un `X-Forwarded-For` de un único valor; una cadena podría falsificarse para evadir los límites.

**¿Varias instancias?** El contador de límites por omisión vive en memoria, por proceso, así que
el límite real se multiplica por el número de instancias. Usa `rateLimitStorage: 'database'`.

**¿Sesiones en `secondaryStorage` (Redis)?** Entonces Better Auth guarda una copia de la fila del
usuario junto a cada sesión y solo la refresca cuando él mismo cambia al usuario. Los cambios de
Axeda (una asignación revocada, la marca de 2FA) no llegarían a esa copia, así que con
`secondaryStorage` los endpoints del plugin y `sessionPrincipal` releen al usuario de la base de
datos: una consulta más por petición, a cambio de que una revocación valga al instante.

## Lista antes de salir a producción

- [ ] `BETTER_AUTH_SECRET` es aleatorio, vive en un gestor de secretos y no en el repositorio
- [ ] El sitio se sirve solo por HTTPS; `baseURL` y cada origen de confianza son `https`
- [ ] `trustedOrigins` lista solo tus front ends
- [ ] CORS permite exactamente esos orígenes, con credenciales; nunca `*`
- [ ] `trust proxy` (Express) y `trustedProxies` (Better Auth) coinciden con tus proxies reales
- [ ] Los correos de verificación e invitación salen por un proveedor real; los enlaces no se escriben en los registros
- [ ] Tus propias rutas tienen límites de peticiones, límite de tamaño del cuerpo y cabeceras de seguridad
- [ ] El 2FA está activado en las cuentas con funciones administrativas (abajo)
- [ ] La base de datos tiene transacciones reales (SQLite, PostgreSQL); las copias de seguridad están probadas
- [ ] `purgeDeleted()` corre con una programación si dependes de que las compañías borradas desaparezcan
- [ ] Alguien vigila la auditoría

## Autenticación en dos pasos para administradores

Marca las funciones delicadas con `requireMfa: true`. Esa función no concede nada a un usuario sin
2FA. Sé preciso con lo que significa: la sesión de Better Auth **no** registra si esa sesión pasó
un segundo factor, solo si el usuario **tiene** el 2FA activado. Y «confiar en este dispositivo»
se salta el código. En las cuentas administrativas, desactiva los dispositivos de confianza en el
plugin `twoFactor`.

## Llaves de API

Si usas el plugin `apiKey` de Better Auth con sesiones para las llaves, construye a quien llama con
`await principalFromSession(ctx)` / `sessionPrincipal`, que llevan las marcas `banned` y de 2FA. Un usuario
bloqueado no tiene ningún permiso ni siquiera con una llave.

## Límites conocidos

Dichos con claridad, para que puedas decidir:

- **Bases de datos.** Verificadas: SQLite y PostgreSQL (PostgreSQL mediante un motor dentro del
  proceso; las pruebas contra un servidor real con grupo de conexiones están programadas antes de
  la primera versión). MySQL y MongoDB aún no se soportan.
- **Una sola autoridad.** Axeda es la única fuente de permisos. Los plugins `admin` y `organization` de Better Auth tienen roles propios; Axeda los ignora, así que no los consultes en tus rutas o tendrás dos sistemas que pueden discrepar.
- **Los menús** son de solo lectura y vienen del código; editarlos por la API está previsto.
- **Los mensajes** de la API están en inglés; los códigos (`AXEDA_*`) son estables y están pensados
  para que los traduzcas.
- **La retención de la auditoría** no es automática: el registro solo crece. Archívalo por tu lado por ahora.
- **Las invitaciones pendientes** aún no tienen tope por alcance.
- **`user/list` con `banned`** filtra después de la consulta, así que una página puede traer menos filas que el límite.
- **La concurrencia en un servidor real** (muchos escritores en paralelo sobre un PostgreSQL) está
  cubierta con operaciones atómicas en las pruebas, pero aún no se ha sometido a carga en un servidor real.
