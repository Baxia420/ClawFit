import { beforeEach,describe,it,expect,vi } from "vitest";
const mocks=vi.hoisted(()=>({auth:vi.fn(),api:vi.fn()}));
vi.mock("../../../auth",()=>({auth:mocks.auth}));
vi.mock("../../../lib/api",()=>({healthApiRequest:mocks.api,HealthApiError:class extends Error{status=500;}}));
import {GET,POST} from "./route";
const write=(body:object,origin="https://clawfit.example")=>new Request("https://clawfit.example/api/exercise-library",{method:"POST",headers:{origin,host:"clawfit.example","content-type":"application/json"},body:JSON.stringify(body)});
describe("library web adapter",()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({user:{id:"signed-in-owner"}});mocks.api.mockResolvedValue({favorite:true});});
 it("refuses unauthenticated reads and cross-origin writes",async()=>{
  expect((await POST(write({action:"favorite",id:"edb:0025",favorite:true},"https://other.example"))).status).toBe(403);
  mocks.auth.mockResolvedValue(null);
  expect((await GET(new Request("https://clawfit.example/api/exercise-library"))).status).toBe(401);
  expect(mocks.api).not.toHaveBeenCalled();
 });
 it("binds personal writes to session identity and rejects paths outside the library",async()=>{
  expect((await POST(write({action:"favorite",id:"edb:0025",favorite:true,userId:"partner"}))).status).toBe(200);
  expect(mocks.api).toHaveBeenCalledWith("/v1/exercise-library/edb%3A0025/favorite",{method:"PUT",body:'{"favorite":true}',userId:"signed-in-owner"});
  mocks.api.mockClear();
  expect((await GET(new Request("https://clawfit.example/api/exercise-library?id=../../users"))).status).toBe(400);
  expect((await POST(write({action:"delete",id:"edb:0025"}))).status).toBe(400);
  expect(mocks.api).not.toHaveBeenCalled();
 });
 it("bounds pagination and marks personal results private and uncached",async()=>{
  const result=await GET(new Request("https://clawfit.example/api/exercise-library?q=bench&scope=favorites"));
  expect(result.status).toBe(200);expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.api.mock.calls[0]?.[1]).toEqual({userId:"signed-in-owner"});
  expect((await GET(new Request("https://clawfit.example/api/exercise-library?limit=100000"))).status).toBe(400);
 });
});
