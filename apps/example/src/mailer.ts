/** Un correo saliente. */
export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly link: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Sustituto de un proveedor de correo para el ejemplo: guarda los mensajes en memoria (las
 * pruebas los leen) y los escribe en la consola. **En producción pon aquí tu proveedor** (SES,
 * Resend, SMTP…); los enlaces llevan un secreto y no deben quedar en los registros.
 */
export function createDevMailer(log: (line: string) => void = console.log): Mailer & {
  readonly outbox: Mail[];
} {
  const outbox: Mail[] = [];
  return {
    outbox,
    async send(mail) {
      outbox.push(mail);
      log(`[dev mailer] to=${mail.to} subject="${mail.subject}" link=${mail.link}`);
    },
  };
}
