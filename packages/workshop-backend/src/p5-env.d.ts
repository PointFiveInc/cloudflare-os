/** What os.pointfive.co's deploy sets on this Worker. Unset, every p5- change keeps Cloudflare's behaviour. */
declare namespace Cloudflare {
  interface Env {
    P5_COLLABORATION?: string;
  }
}
