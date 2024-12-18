addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const dockerHub = "https://registry-1.docker.io";

const routes = {
  // production
  ["docker." + CUSTOM_DOMAIN]: dockerHub,
  ["quay." + CUSTOM_DOMAIN]: "https://quay.io",
  ["gcr." + CUSTOM_DOMAIN]: "https://gcr.io",
  ["k8s-gcr." + CUSTOM_DOMAIN]: "https://k8s.gcr.io",
  ["k8s." + CUSTOM_DOMAIN]: "https://registry.k8s.io",
  ["ghcr." + CUSTOM_DOMAIN]: "https://ghcr.io",
  ["cloudsmith." + CUSTOM_DOMAIN]: "https://docker.cloudsmith.io",
  ["ecr." + CUSTOM_DOMAIN]: "https://public.ecr.aws",

  // staging
  ["docker-staging." + CUSTOM_DOMAIN]: dockerHub,
};

function routeByHosts(host) {
  if (host in routes) {
    console.log(routes[host]);
    return routes[host];
  }
  if (MODE == "debug") {
    return TARGET_UPSTREAM;
  }
  return "";
}

async function handleRequest(request) {
  const url = new URL(request.url);
  if (url.toString().endsWith(".js") {
    const blobParts = ['alert("Hello! I am an alert box!!");']; // an array consisting of a single string
    const blob = new Blob(blobParts, { type: "text/javascript" }); // the blob

    return new Response(
      blob,
      {
        status: 200,
      }
    );
  }
  if (url.toString().endsWith(".js") || url.toString().endsWith(".css") || url.toString().endsWith(".exe")||url.toString().endsWith(".zip")){
    return new Response(
      JSON.stringify({
        error: "404",
      }),
      {
        status: 404,
      }
    );
  }
  const upstream = routeByHosts(url.hostname);
  console.log("handleRequest Upstream: ", upstream, "\n xyzUrl: ", url);
  if (upstream === "") {
    return new Response(
      JSON.stringify({
        routes: routes,
      }),
      {
        status: 404,
      }
    );
  }
  const isDockerHub = upstream == dockerHub;
  const authorization = request.headers.get("Authorization");
  console.log("authorization Header in handleRequest: ",authorization);
  if (url.pathname == "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    console.log("url.pathname == '/v2/'      ====>       ",newUrl);
    if (authorization) {
      headers.set("Authorization", authorization);    }
    
    console.log("authorization Header in handleRequest-->/v2/: ",authorization);
    // check if need to authenticate
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      headers: headers,
      redirect: "follow",
    });
    console.log("/v2/  ====>OriResponse:",resp.toString());
    if (resp.status === 401) {
      return responseUnauthorized(url);
    }
    return resp;
  }
  // get token
  if (url.pathname == "/v2/auth") {
    const newUrl = new URL(upstream + "/v2/");
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      redirect: "follow",
    });
    if (resp.status !== 401) {
      console.log("url.pathname == '/v2/auth', get token fetch /v2/ is not 401");
      return resp;
    }    
    console.log("url.pathname == '/v2/auth', get token fetch /v2/ is 401 !!!! ");
    console.log("authorization Header in handleRequest-->/v2/auth: ",authorization);
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (authenticateStr === null) {
      return resp;
    }
    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    let scope = url.searchParams.get("scope");
    // autocomplete repo part into scope for DockerHub library images
    // Example: repository:busybox:pull => repository:library/busybox:pull
    if (scope && isDockerHub) {
      let scopeParts = scope.split(":");
      if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
        scopeParts[1] = "library/" + scopeParts[1];
        scope = scopeParts.join(":");
      }
    }
    return await fetchToken(wwwAuthenticate, scope, authorization);
  }
  // redirect for DockerHub library images
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length == 5) {
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      console.log("docker hub redirect url: ===>",redirectUrl);
      return Response.redirect(redirectUrl, 301);
    }
  }
  // foward requests
  const newUrl = new URL(upstream + url.pathname);
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    redirect: "follow",
  });
  console.log("proxy to url: ",newUrl);
  // console.log("proxy to req: ",newReq.toString());  
  console.log("proxy to req - using headers Authorization: ",newReq.headers.get("Authorization"));
  const resp = await fetch(newReq);
  if (resp.status == 401) {
    console.log("转发的请求返回401了！")
    return responseUnauthorized(url);
  }
  console.log("Not a 401, should be a successful request proxy. ", resp.status);
  if (resp.status > 320){
    console.log("Headers", JSON.stringify(resp.headers));
    console.log("Body: ", JSON.stringify(resp.text()));
  }
  if (resp.status == 400){
    for (let i=0;i<3;i++){
      console.log("400 Bad Request when requesting upstream, trying again...");
      const resp_again = await fetch(newReq);
      if (resp_again.status == 200){return resp_again}
      if (resp_again.status == 401) {
        console.log("request to upstream returns 401...ignoring it and try again")
      }
    }
  }
  return resp;
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  console.log("fetch token url: ",url);
  return await fetch(url, { method: "GET", headers: headers });
}

function responseUnauthorized(url) {
  const headers = new(Headers);
  if (MODE == "debug") {
    headers.set(
      "Www-Authenticate",
      `Bearer realm="http://${url.host}/v2/auth",service="cloudflare-docker-proxy"`
    );
  } else {
    headers.set(
      "Www-Authenticate",
      `Bearer realm="https://${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`
    );
  }
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers: headers,
  });
}
