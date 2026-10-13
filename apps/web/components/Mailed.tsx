import { mailParts } from "@/lib/wording";

/**
 * A text of the backend or of the app, as it is. Where it holds an email
 * address, the address is a link that opens the visitor's mail program
 * (decision D-35, api.md v1.17). The link takes the colour and the weight of
 * the text around it.
 */
export default function Mailed({ text }: { text: string }) {
  return (
    <>
      {mailParts(text).map((part, i) =>
        part.mail ? (
          <a key={i} className="mail" href={`mailto:${part.text}`}>
            {part.text}
          </a>
        ) : (
          part.text
        )
      )}
    </>
  );
}
