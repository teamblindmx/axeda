# Registro ASVS

Una autoevaluación de Axeda frente al [Estándar de Verificación de Seguridad de Aplicaciones de OWASP](https://owasp.org/www-project-application-security-verification-standard/) 5.0.0, con el **nivel 2** como meta. No es una certificación: nadie ajeno al proyecto la ha auditado.

ASVS verifica **aplicaciones**; Axeda es una biblioteca dentro de una. Por eso cada requisito se coloca donde corresponde: lo que garantiza Axeda (y la prueba que lo demuestra), lo que da Better Auth y configura el preset, y lo que queda en la aplicación o su despliegue. Los números de requisito son los de ASVS; el texto de aquí es una paráfrasis breve (ASVS tiene licencia CC BY-SA 4.0).

## Cómo leerlo

| Estado        | Significado                                                                       |
| ------------- | --------------------------------------------------------------------------------- |
| **Cumple**    | Axeda lo hace y una prueba o una verificación del CI lo demuestra.                |
| **Parcial**   | Axeda hace una parte; lo que falta se dice.                                       |
| **Delegado**  | Lo hace Better Auth (o Express); el preset lo configura o se niega a debilitarlo. |
| **Tuyo**      | Debe hacerlo la aplicación o su despliegue; la documentación dice cómo.           |
| **No aplica** | Axeda no tiene esa función.                                                       |
| **Brecha**    | No está cubierto. Se conoce y se dice.                                            |

## Resumen

| Estado    | Filas |
| --------- | ----: |
| Cumple    |    52 |
| Parcial   |    18 |
| Delegado  |    11 |
| Tuyo      |    14 |
| No aplica |    11 |
| Brecha    |     2 |

## V8 Autorización

| ASVS   | Nivel | Estado    | Cómo                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | :---: | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V8.1.1 |   1   | Cumple    | Las reglas están escritas: [Conceptos](concepts.md) y el permiso que exige cada endpoint en la [referencia](reference.md).                                                                                                                                                                                                                                                                                         |
| V8.1.2 |   2   | Tuyo      | Axeda autoriza funciones y alcances, no campos sueltos. Las reglas por campo de tus datos son tuyas; las respuestas de Axeda son listas blancas fijas.                                                                                                                                                                                                                                                             |
| V8.1.3 |   2   | Cumple    | Axeda decide por identidad, alcance, estado de la función, fechas de caducidad, un bloqueo y si el 2FA está activado. No usa ubicación, dispositivo ni hora del día. Documentado en [Conceptos](concepts.md).                                                                                                                                                                                                      |
| V8.1.4 |   2   | Cumple    | Igual que V8.1.3: los únicos factores de contexto son los que ahí se listan.                                                                                                                                                                                                                                                                                                                                       |
| V8.2.1 |   1   | Cumple    | Todo endpoint exige sesión y un permiso declarado en su metadato; una prueba los recorre todos (`plugin-http.test.ts`). `requirePermission()` deniega por defecto.                                                                                                                                                                                                                                                 |
| V8.2.2 |   1   | Cumple    | Los objetos de Axeda nunca se alcanzan solo por id: el alcance se resuelve en el servidor y una petición rechazada responde igual con un id real que con uno inventado (`enumeration.test.ts`, 24 operaciones, incluida una persona que administra una compañía sondeando otra). En tus propios recursos, comprueba la propiedad como en el patrón 4 de [Proteger rutas](express.md); el ejemplo tiene una prueba. |
| V8.2.3 |   2   | Parcial   | Los cuerpos son estrictos (los campos desconocidos se rechazan, así que no hay asignación masiva) y las respuestas son listas blancas. Los permisos por campo de tus datos son tuyos.                                                                                                                                                                                                                              |
| V8.2.4 |   2   | No aplica | Axeda no decide por ubicación ni dispositivo. Solo limita peticiones.                                                                                                                                                                                                                                                                                                                                              |
| V8.3.1 |   1   | Cumple    | La autorización se impone en la biblioteca del servidor; un menú es solo una comodidad y así se documenta.                                                                                                                                                                                                                                                                                                         |
| V8.3.2 |   2   | Cumple    | Una caché validada por versión: una revocación aplica en la siguiente petición en cada instancia (`cache-and-queries.test.ts`, `concurrency.test.ts`). Un bloqueo cierra las sesiones al instante.                                                                                                                                                                                                                 |
| V8.3.3 |   2   | Cumple    | Toda operación usa los permisos de quien llama (un `Principal` armado desde la sesión); nada corre bajo la identidad de un servicio. Un principal bloqueado no tiene nada, por ninguna vía (`banned-reads.test.ts`).                                                                                                                                                                                               |
| V8.4.1 |   2   | Cumple    | Aislamiento entre compañías: la compañía de un negocio se lee de la base de datos y nadie puede conceder, editar ni bloquear para pasar de su propio nivel (`escalation.property.test.ts`, `tenants-http.test.ts`).                                                                                                                                                                                                |
| V8.4.2 |   2   | Parcial   | Las acciones administrativas exigen permisos `axeda:*` y, en las funciones marcadas `requireMfa`, el 2FA activado. Axeda no evalúa el dispositivo ni pide una sesión reciente (ver V7.5.1).                                                                                                                                                                                                                        |

## V2 Validación y lógica de negocio

| ASVS   | Nivel | Estado    | Cómo                                                                                                                                                                                                                            |
| ------ | :---: | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2.1.1 |   1   | Parcial   | Toda entrada es un esquema estricto y los límites están en la [referencia](reference.md); aún no hay una descripción legible por máquinas (OpenAPI).                                                                            |
| V2.1.2 |   2   | No aplica | Axeda no tiene reglas de campos combinados más allá de las de V2.2.3.                                                                                                                                                           |
| V2.1.3 |   2   | Cumple    | Los límites están documentados y son configurables: asignaciones por usuario, permisos por función, funciones por invitación, tamaño del menú y de la página.                                                                   |
| V2.2.1 |   1   | Cumple    | Esquemas estrictos de lista blanca (`zod`) en todo cuerpo y consulta: la sintaxis de permisos, los slugs, las rutas del menú, el alcance y la caducidad se validan y los campos desconocidos se rechazan (`hardening.test.ts`). |
| V2.2.2 |   1   | Cumple    | La validación corre en la biblioteca del servidor; nada depende del cliente.                                                                                                                                                    |
| V2.2.3 |   2   | Cumple    | Los valores relacionados se comprueban juntos: un negocio debe pertenecer a la compañía de la ruta, los permisos de una función deben valer en el nivel del alcance, una caducidad debe estar en el futuro.                     |
| V2.3.1 |   1   | Cumple    | Las invitaciones se cierran de forma atómica (crear y aceptar una vez) y `bootstrap` funciona una vez; ambos probados con llamadas simultáneas (`concurrency.test.ts`).                                                         |
| V2.3.2 |   2   | Cumple    | Los límites se imponen y se prueban, también frente a escritores simultáneos.                                                                                                                                                   |
| V2.3.3 |   2   | Cumple    | Toda escritura administrativa es una transacción junto con su registro de auditoría, y Axeda se niega a arrancar en una base de datos sin transacciones reales.                                                                 |
| V2.3.4 |   2   | Cumple    | Guardas atómicas (`incrementOne`, índices únicos) protegen versiones, límites y cierres de un solo uso; probado con escritores en paralelo contra PostgreSQL 16 y 18 en el CI.                                                  |
| V2.4.1 |   2   | Parcial   | Límites de peticiones en los endpoints de Axeda (120 por minuto, 30 en el público) y, con el preset, en el inicio de sesión, el registro y el restablecimiento. Tus propias rutas son tuyas.                                    |

## V4 API y servicios web

| ASVS             | Nivel | Estado    | Cómo                                                                                                                                                 |
| ---------------- | :---: | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| V4.1.1           |   1   | Delegado  | Las respuestas son JSON con el `Content-Type` correcto, producido por Better Auth y Express.                                                         |
| V4.1.2           |   2   | Tuyo      | Redirigir de HTTP a HTTPS es cosa del despliegue. El preset rechaza URL sin HTTPS en producción.                                                     |
| V4.1.3           |   2   | Parcial   | Proxies: `trustedProxies` en el preset y `trust proxy` de Express. Sin ellos, una cadena `X-Forwarded-For` falsificada se ignora (`preset.test.ts`). |
| V4.2.1           |   2   | Tuyo      | Cómo se delimita una petición lo deciden tus servidores y proxies.                                                                                   |
| V4.3.1 to V4.4.4 |   2   | No aplica | Axeda no tiene GraphQL ni WebSocket.                                                                                                                 |

## V6 Autenticación

| ASVS              | Nivel | Estado   | Cómo                                                                                                                                                                                                                     |
| ----------------- | :---: | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V6.1.1            |   1   | Parcial  | El preset activa límites documentados (inicio de sesión 5 por minuto, registro 5 cada 5 minutos, restablecimiento 3 cada 5 minutos); ver [Seguridad](security.md).                                                       |
| V6.2.1            |   1   | Delegado | Better Auth. El preset exige de 12 a 128 caracteres.                                                                                                                                                                     |
| V6.2.2 and V6.2.3 |   1   | Delegado | Better Auth: cambiar la contraseña exige la actual.                                                                                                                                                                      |
| V6.2.4            |   1   | Tuyo     | No está en el preset. Activa el plugin `haveIBeenPwned` de Better Auth, o una comprobación equivalente.                                                                                                                  |
| V6.3.1            |   1   | Delegado | Better Auth con los límites del preset; probado: el sexto intento de inicio de sesión desde una dirección se rechaza (`preset.test.ts`).                                                                                 |
| V6.4.1            |   1   | Cumple   | Axeda crea cuentas sin ninguna credencial, así que no hay contraseña inicial; la persona la establece por el flujo normal de Better Auth.                                                                                |
| V6.5.1 to V6.5.5  |   2   | Cumple   | Los secretos de invitación (los únicos códigos que emite Axeda): de un solo uso, 256 bits de un CSPRNG, guardados solo como hash SHA-256 y con vigencia limitada (72 horas por defecto) (`invitations-service.test.ts`). |
| V6 (rest)         |   —   | Delegado | Todo lo demás sobre credenciales, segundos factores e identidad federada es de Better Auth y sus plugins; revisa su documentación y tu configuración.                                                                    |

## V7 Gestión de sesiones

| ASVS              | Nivel | Estado   | Cómo                                                                                                                                                                                                         |
| ----------------- | :---: | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V7.1.1            |   2   | Cumple   | Las vigencias están documentadas: 7 días, renovadas a diario, 15 minutos "recientes" ([Seguridad](security.md)).                                                                                             |
| V7.1.2            |   2   | Tuyo     | Better Auth admite cualquier número de sesiones simultáneas; limítalas si lo necesitas.                                                                                                                      |
| V7.2.1            |   1   | Cumple   | Toda comprobación consulta a Better Auth en el servidor. Axeda se niega a arrancar con la caché de cookie de sesión activa, así que una sesión revocada no puede seguir vigente (`plugin-http.test.ts`).     |
| V7.2.2 to V7.2.4  |   1   | Delegado | Better Auth genera tokens de referencia aleatorios con un CSPRNG y emite uno nuevo en cada inicio de sesión.                                                                                                 |
| V7.3.1 and V7.3.2 |   2   | Parcial  | Las sesiones caducan a los 7 días y se renuevan con el uso. No hay un máximo absoluto aparte: una sesión de uso diario no caduca sola.                                                                       |
| V7.4.1            |   1   | Cumple   | Una sesión terminada se rechaza en la siguiente petición (sin caché; ver V7.2.1).                                                                                                                            |
| V7.4.2            |   1   | Cumple   | Un bloqueo cierra todas las sesiones abiertas y bloquea las nuevas (`users-http.test.ts`); borrar un usuario elimina sus sesiones en Better Auth.                                                            |
| V7.4.3            |   2   | Delegado | El preset cierra todas las sesiones al restablecer la contraseña; cambiarla también puede revocar las demás sesiones (Better Auth).                                                                          |
| V7.4.4            |   2   | Tuyo     | El control para cerrar sesión es parte de tu front end.                                                                                                                                                      |
| V7.4.5            |   2   | Cumple   | `POST /axeda/user/revoke-sessions` cierra las sesiones de una persona en todas partes, con `axeda:user:manage` y sin tocar a alguien con más poder (`users-service.test.ts`).                                |
| V7.5.1            |   2   | Brecha   | Los endpoints administrativos de Axeda no piden una sesión autenticada hace poco (el `freshAge` de Better Auth protege sus propios endpoints sensibles, no los de Axeda). Candidato para una versión futura. |
| V7.5.2            |   2   | Delegado | Better Auth lista y revoca las sesiones de la propia persona.                                                                                                                                                |
| V7.6.1 and V7.6.2 |   2   | Delegado | Better Auth y sus proveedores de identidad.                                                                                                                                                                  |

## V11 Criptografía

| ASVS                                                                     | Nivel | Estado    | Cómo                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | :---: | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V11.2.1                                                                  |   2   | Cumple    | Solo se usan las implementaciones estándar de la plataforma (`crypto.getRandomValues`, `crypto.subtle`); no hay criptografía propia.                                                    |
| V11.2.3                                                                  |   2   | Cumple    | Un secreto de 256 bits con hash SHA-256: más de 128 bits de seguridad.                                                                                                                  |
| V11.4.1                                                                  |   1   | Cumple    | SHA-256 es el único hash que usa Axeda.                                                                                                                                                 |
| V11.4.2                                                                  |   2   | Delegado  | Axeda nunca maneja contraseñas. Better Auth las guarda con scrypt.                                                                                                                      |
| V11.5.1                                                                  |   2   | Cumple    | Todo valor no adivinable que crea Axeda (secretos de invitación) sale de un CSPRNG; las comparaciones de secretos son en tiempo constante. No hay `Math.random` en el código publicado. |
| V11.1.1, V11.1.2, V11.2.2, V11.3.1 to V11.3.3, V11.4.3, V11.4.4, V11.6.1 |   2   | No aplica | Axeda no cifra, no firma ni deriva claves; la criptografía que usa es la de arriba.                                                                                                     |

## V13 Configuración

| ASVS                | Nivel | Estado    | Cómo                                                                                                                                                    |
| ------------------- | :---: | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V13.1.1             |   2   | Cumple    | Axeda no hace conexiones salientes. Su único efecto externo es tu función `invitationDelivery.send`.                                                    |
| V13.2.1 and V13.2.2 |   2   | Tuyo      | La conexión a tu base de datos la configuras tú: usa credenciales propias y TLS.                                                                        |
| V13.2.3             |   2   | Cumple    | No hay credenciales por omisión: el secreto y las URL no tienen valor por omisión y el preset rechaza un secreto corto o repetitivo (`preset.test.ts`). |
| V13.2.4 and V13.2.5 |   2   | No aplica | Axeda no envía peticiones a ningún recurso externo.                                                                                                     |
| V13.3.1 and V13.3.2 |   2   | Tuyo      | Guarda `BETTER_AUTH_SECRET` y las credenciales de la base de datos en un gestor de secretos (la lista está en [Seguridad](security.md)).                |
| V13.4.1             |   1   | Cumple    | Los paquetes publicados contienen solo `dist` y los archivos legales; `pack:check` falla si entraran fuentes, `.git` o `.env`.                          |
| V13.4.2             |   2   | Parcial   | Axeda no tiene modo de depuración y devuelve errores genéricos; no actives el registro detallado de Better Auth en producción.                          |
| V13.4.3 to V13.4.5  |   2   | Tuyo      | Los listados de directorios, el método TRACE y los endpoints de documentación o monitoreo expuestos los decide tu servidor web.                         |

## V14 Protección de datos

| ASVS    | Nivel | Estado    | Cómo                                                                                                                                                                                                                                                        |
| ------- | :---: | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V14.1.1 |   2   | Cumple    | Clasificado en [Datos que guarda Axeda](#datos-que-guarda-axeda) más abajo.                                                                                                                                                                                 |
| V14.1.2 |   2   | Parcial   | Las protecciones están abajo. El registro de auditoría no tiene retención automática y solo crece; archívalo por tu lado.                                                                                                                                   |
| V14.2.1 |   1   | Parcial   | La API de Axeda no envía nada sensible en una URL. El enlace de invitación lleva su secreto en la consulta por diseño, como un enlace de restablecimiento: es de un solo uso, caduca y se guarda con hash; envíalo solo por HTTPS y fuera de los registros. |
| V14.2.2 |   2   | Cumple    | `Cache-Control: no-store` en toda respuesta de Axeda; la caché de permisos está en la memoria de cada proceso, acotada a 10 000 usuarios y validada contra la base de datos en cada uso.                                                                    |
| V14.2.3 |   2   | Tuyo      | Axeda no envía nada a terceros; lo que envíe tu front end es tuyo.                                                                                                                                                                                          |
| V14.2.4 |   2   | Parcial   | Los metadatos de auditoría nunca llevan secretos y están limitados a 2 KB; la retención no es automática (ver V14.1.2).                                                                                                                                     |
| V14.3.1 |   1   | No aplica | Axeda no tiene interfaz y su plugin de cliente no guarda nada.                                                                                                                                                                                              |
| V14.3.2 |   2   | Cumple    | `Cache-Control: no-store` en toda respuesta de `/axeda/*`, errores incluidos (`hardening.test.ts`), y en toda denegación de `@axeda/express`.                                                                                                               |
| V14.3.3 |   2   | Cumple    | Nada en el almacenamiento del navegador; las únicas cookies son las de Better Auth, `HttpOnly`.                                                                                                                                                             |

## V15 Codificación segura y arquitectura

| ASVS    | Nivel | Estado    | Cómo                                                                                                                                                                                     |
| ------- | :---: | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V15.1.1 |   1   | Cumple    | Los plazos de corrección (7 días para alta y crítica, 30 para moderada) están en `SECURITY.md`.                                                                                          |
| V15.1.2 |   2   | Cumple    | `npm run sbom` escribe un inventario CycloneDX por paquete y el CI lo conserva. Los paquetes publicados tienen una dependencia de terceros, `zod`.                                       |
| V15.1.3 |   2   | Parcial   | El trabajo costoso está acotado: páginas de máximo 100, una caché de máximo 10 000 usuarios, límites por usuario y por función. `purgeDeleted()` está pensada para una tarea programada. |
| V15.2.1 |   1   | Cumple    | `npm audit` corre en cada pull request y cada semana, con verificación de firmas y procedencia; sin vulnerabilidades conocidas al escribir esto.                                         |
| V15.2.2 |   2   | Parcial   | Límites de peticiones, tope de páginas y una caché acotada; no hay un presupuesto de tiempo por petición.                                                                                |
| V15.2.3 |   2   | Cumple    | Apagado salvo que se configure: el endpoint de identidad pública, las invitaciones y la administración de usuarios. Los tarballs contienen solo `dist`.                                  |
| V15.3.1 |   1   | Cumple    | Las respuestas son listas blancas fijas; una prueba comprueba que ninguna respuesta de usuarios contiene `password`, `token`, `hash` ni `secret` (`users-http.test.ts`).                 |
| V15.3.2 |   2   | No aplica | Axeda no hace peticiones HTTP salientes.                                                                                                                                                 |
| V15.3.3 |   2   | Cumple    | Los esquemas estrictos rechazan campos desconocidos y toda respuesta copia los campos uno a uno.                                                                                         |
| V15.3.4 |   2   | Parcial   | `trustedProxies` en el preset y `trust proxy` en Express; la dirección llega a la auditoría. Configurarlos es cosa tuya.                                                                 |
| V15.3.5 |   2   | Cumple    | TypeScript en modo estricto, ESLint `eqeqeq` y análisis con `zod` en cada frontera.                                                                                                      |
| V15.3.6 |   2   | Cumple    | Las claves desconocidas, incluidas `__proto__` y `constructor`, se rechazan con 400 y `Object.prototype` no se toca (`hardening.test.ts`).                                               |
| V15.3.7 |   2   | Cumple    | Los parámetros repetidos o en arreglo se rechazan con 400 (`hardening.test.ts`); `@axeda/express` también los rechaza (`express.test.ts`).                                               |

## V16 Registro de seguridad y manejo de errores

| ASVS                | Nivel | Estado  | Cómo                                                                                                                                                                                                                     |
| ------------------- | :---: | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V16.1.1             |   2   | Parcial | La auditoría es el registro de lo que ocurre en Axeda y está documentada. Axeda no escribe registros de aplicación: los errores inesperados van a tu manejador de errores.                                               |
| V16.2.1             |   2   | Cumple  | Cada evento de auditoría registra cuándo, quién (actor), qué (acción), sobre qué (objetivo y alcance), el resultado, la dirección y el agente de usuario.                                                                |
| V16.2.2             |   2   | Cumple  | Las marcas de tiempo son UTC y los ids están ordenados cronológicamente.                                                                                                                                                 |
| V16.2.3 and V16.2.4 |   2   | Tuyo    | A dónde van los registros y en qué formato lo decide tu pila de registro.                                                                                                                                                |
| V16.2.5             |   2   | Cumple  | Los secretos nunca llegan a la auditoría y los metadatos están limitados a 2 KB.                                                                                                                                         |
| V16.3.1             |   2   | Brecha  | Better Auth no guarda un registro de autenticación y Axeda audita la autorización, no los inicios de sesión. Regístralos con los hooks de Better Auth.                                                                   |
| V16.3.2             |   2   | Cumple  | Los intentos administrativos denegados se auditan, fuera de la transacción que se revirtió (`assignments-service.test.ts`, `roles-service.test.ts`).                                                                     |
| V16.3.3             |   2   | Parcial | Los bloqueos, concesiones, revocaciones, ediciones de funciones, `bootstrap` y denegaciones se auditan. Una escritura entre sitios rechazada por `@axeda/express` se responde con 403 pero la biblioteca no la registra. |
| V16.3.4             |   2   | Parcial | Los errores inesperados se vuelven un 500 genérico y llegan a tu manejador de errores; registrarlos es cosa tuya.                                                                                                        |
| V16.4.1             |   2   | Cumple  | Los eventos de auditoría son datos estructurados, no texto concatenado.                                                                                                                                                  |
| V16.4.2             |   2   | Parcial | La biblioteca no ofrece forma de editar ni borrar eventos de auditoría (el almacén no tiene esa operación); protege la tabla con permisos de la base de datos.                                                           |
| V16.4.3             |   2   | Tuyo    | Enviar los registros a un sistema aparte es cosa tuya.                                                                                                                                                                   |
| V16.5.1             |   2   | Cumple  | Todo lo inesperado se vuelve `AXEDA_INTERNAL_ERROR` con un mensaje genérico; los errores de configuración y de datos nunca se detallan a un cliente.                                                                     |
| V16.5.2             |   2   | Cumple  | Una entrega fallida se informa (`AXEDA_DELIVERY_FAILED`) después de confirmar los datos y puede reenviarse; Axeda se niega a arrancar sin transacciones reales.                                                          |
| V16.5.3             |   2   | Cumple  | Falla cerrando: `@axeda/express` nunca ejecuta la ruta cuando falla una consulta (`express.test.ts`).                                                                                                                    |

## Los demás capítulos

| ASVS | Nivel | Estado    | Cómo                                                                                                    |
| ---- | :---: | --------- | ------------------------------------------------------------------------------------------------------- |
| V1   |   —   | Tuyo      | Axeda responde solo JSON; escapa lo que muestres. `invitationDelivery.send` recibe datos, no HTML.      |
| V3   |   —   | No aplica | Axeda no tiene front end web.                                                                           |
| V5   |   —   | No aplica | No se manejan archivos; los logos son URL.                                                              |
| V9   |   —   | No aplica | Axeda no emite ni acepta tokens autocontenidos (ni JWT).                                                |
| V10  |   —   | Delegado  | OAuth y OpenID Connect, si los usas, son de Better Auth.                                                |
| V12  |   —   | Tuyo      | El TLS lo terminas tú; el preset rechaza URL sin HTTPS en producción y marca las cookies como `Secure`. |
| V17  |   —   | No aplica | Sin WebRTC.                                                                                             |

Los capítulos que no aparecen uno a uno se aplican a la aplicación, no a la biblioteca.

## Datos que guarda Axeda

Qué conserva Axeda, desde dónde puede leerse y cómo se protege (V14.1).

| Dato                 | Qué contiene                                                                                                                                  | Protección                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Asignaciones         | Id del usuario, id de la función, alcance, quién la concedió, fecha de caducidad.                                                             | Solo se leen con `axeda:assignment:manage` en ese alcance, o por la propia persona.                                                              |
| Eventos de auditoría | Actor, acción, objetivo, alcance, resultado, dirección (64 caracteres como máximo), agente de usuario (255) y metadatos (2 KB, sin secretos). | Solo se añaden en la biblioteca; se leen con `axeda:audit:read`; respuestas `no-store`.                                                          |
| Invitaciones         | Correo, alcance, ids de funciones, quién invitó, caducidad y el hash SHA-256 del secreto (nunca el secreto).                                  | Los listados nunca devuelven el hash; el secreto es de 256 bits, de un solo uso, y solo lo acepta quien tiene verificado el correo.              |
| Campos del usuario   | Añadidos al usuario de Better Auth: `authzVersion`, `banned`, `banReason`, `banExpires`.                                                      | Las respuestas copian una lista fija de campos (id, correo, nombre, `emailVerified`, `twoFactorEnabled`, campos del bloqueo, fecha de creación). |
| Compañías y negocios | Nombre, slug, URL de logo y favicon, un objeto `metadata` libre (tuyo).                                                                       | Visibles para sus miembros y la administración de la plataforma; lo borrado se conserva solo durante el periodo de gracia.                       |

## Brechas conocidas

Todo lo marcado Brecha o Parcial arriba, en un solo lugar, para que nada sea una sorpresa:

- Los endpoints administrativos de Axeda no exigen una sesión autenticada hace poco (V7.5.1).
- Better Auth no guarda un registro de autenticación y Axeda audita solo la autorización (V16.3.1).
- No hay una vigencia máxima absoluta de la sesión; una sesión de uso diario no caduca sola (V7.3).
- La auditoría no tiene retención automática y depende de los permisos de la base de datos para no modificarse (V14.1.2, V16.4.2).
- La comprobación de contraseñas comunes no está en el preset (V6.2.4).
- Aún no hay una descripción de la API legible por máquinas (V2.1.1).
