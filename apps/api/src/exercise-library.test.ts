import { describe,it,expect,vi } from "vitest";
import { SignJWT } from "jose";
import { type HealthRepository, DEFAULT_PARTNER_USER_ID } from "@clawfit/db";
import { createApp } from "./create-app.js";
describe("authenticated exercise library API",()=>{
 it("uses the assertion subject for all personal data and validates inputs before the repository",async()=>{
  const assertionSecret="library-test-secret-at-least-32-characters";
  const token=await new SignJWT({sub:DEFAULT_PARTNER_USER_ID}).setProtectedHeader({alg:"HS256"}).setIssuer("clawfit-web").setAudience("clawfit-health-api").setIssuedAt().setExpirationTime("1m").sign(new TextEncoder().encode(assertionSecret));
  const repository={getUser:vi.fn().mockResolvedValue({id:DEFAULT_PARTNER_USER_ID,active:true}),librarySearch:vi.fn().mockResolvedValue({items:[]}),favoriteExercise:vi.fn().mockResolvedValue({favorite:true}),createCustomExercise:vi.fn()} as unknown as HealthRepository;
  const app=createApp({repository,webToken:"test-web-token-at-least-24-chars",openclawToken:"test-claw-token-at-least-24-chars",assertionSecret,logger:false});
  const headers={authorization:`Bearer ${token}`};
  expect((await app.inject({method:"GET",url:"/v1/exercise-library"})).statusCode).toBe(401);
  expect((await app.inject({method:"GET",url:"/v1/exercise-library?scope=favorites&userId=someone-else",headers})).statusCode).toBe(200);
  expect(repository.librarySearch).toHaveBeenCalledWith(DEFAULT_PARTNER_USER_ID,expect.objectContaining({scope:"favorites"}));
  expect((await app.inject({method:"PUT",url:"/v1/exercise-library/edb:0025/favorite",headers,payload:{favorite:true,userId:"someone-else"}})).statusCode).toBe(200);
  expect(repository.favoriteExercise).toHaveBeenCalledWith(DEFAULT_PARTNER_USER_ID,"edb:0025",true);
  expect((await app.inject({method:"POST",url:"/v1/exercise-library/custom",headers,payload:{name:"Unsafe",mediaUrl:"http://127.0.0.1/private"}})).statusCode).toBe(400);
  expect(repository.createCustomExercise).not.toHaveBeenCalled();
  await app.close();
 });
});
