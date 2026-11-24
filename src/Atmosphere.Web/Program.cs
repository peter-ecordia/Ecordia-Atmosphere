// Ecordiargus's web host (spec: Ecordiargus, 21 Nov 2026). Ecordiargus is an offline web app (wwwroot):
// this host only serves its files, with the right security headers, and tells it where Ecordiatlas is (/config.json).
// Everything else (sign-in, rubrics, observations, encryption keys) is Ecordiatlas's API. Ecordiargus and Ecordiatlas
// must share a parent domain (e.g. atmosphere.ecordia.co.uk and ilr.ecordia.co.uk), so the Ecordiatlas sign-in
// carries across; Ecordiatlas's Atmosphere:Url must name this site.

var builder = WebApplication.CreateBuilder(args);
var atlasUrl = (builder.Configuration["Atlas:Url"] ?? "").Trim().TrimEnd('/');
if (!Uri.TryCreate(atlasUrl, UriKind.Absolute, out var atlas) || atlas.Scheme is not ("https" or "http"))
    throw new InvalidOperationException("Set Atlas:Url to Ecordiatlas's address, e.g. https://ilr.ecordia.co.uk.");
var atlasOrigin = atlas.GetLeftPart(UriPartial.Authority);

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
    app.UseHttpsRedirection();
}

app.Use((http, next) =>
{
    var h = http.Response.Headers;
    h["X-Content-Type-Options"] = "nosniff";
    h["Referrer-Policy"] = "strict-origin-when-cross-origin";
    h["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()";   // photos come through the file picker
    // Photos are shown from blob: addresses (decrypted on the device); the only other site it talks to is Ecordiatlas.
    h["Content-Security-Policy"] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; worker-src 'self'; " +
        $"manifest-src 'self'; connect-src 'self' {atlasOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self' {atlasOrigin}";
    return next();
});

// Where Ecordiatlas is. Cached by the service worker, so Ecordiargus still knows when it opens with no signal.
app.MapGet("/config.json", (HttpContext http) =>
{
    http.Response.Headers.CacheControl = "no-cache";
    return Results.Json(new Dictionary<string, string> { ["AtlasUrl"] = atlasUrl });
});
app.MapGet("/healthz", () => Results.Ok("ok"));

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    // Fixed file names: browsers (and the service worker) check for a newer copy each time; a quick 304 when unchanged.
    OnPrepareResponse = ctx =>
    {
        if (Path.GetExtension(ctx.File.Name) is ".html" or ".js" or ".css" or ".json" or ".svg") ctx.Context.Response.Headers.CacheControl = "no-cache";
    }
});

app.Run();
