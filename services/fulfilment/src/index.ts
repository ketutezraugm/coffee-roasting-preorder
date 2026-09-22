import { app } from "./app.js";
import { migrate } from "./db.js";

const port = Number(process.env.PORT ?? 3003);

await migrate();
app.listen(port, () => console.log(`fulfilment listening on ${port}`));
