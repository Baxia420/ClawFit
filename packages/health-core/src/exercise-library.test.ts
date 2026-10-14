import { describe,it,expect } from "vitest";
import { customExerciseSchema, libraryIdSchema, libraryQuerySchema, youtubeVideoId } from "./exercise-library.js";
describe("exercise library boundaries",()=>{
  it("accepts only supported video URLs, never arbitrary media or executable content",()=>{
    expect(youtubeVideoId("https://youtu.be/abcdefghijk")).toBe("abcdefghijk");
    expect(youtubeVideoId("https://www.youtube.com/watch?v=abcdefghijk")).toBe("abcdefghijk");
    for(const url of ["javascript:alert(1)","http://youtube.com/watch?v=abcdefghijk","https://youtube.com.evil.test/watch?v=abcdefghijk","https://127.0.0.1/image.png","https://user:pass@youtube.com/watch?v=abcdefghijk","https://youtube.com:444/watch?v=abcdefghijk","data:image/svg+xml,test"])expect(youtubeVideoId(url)).toBeNull();
    expect(customExerciseSchema.safeParse({name:"Custom",instructions:["Step"],muscleGroup:"chest",primaryMuscles:["chest"],equipment:"none",mediaUrl:"https://example.com/file.svg"}).success).toBe(false);
  });
  it("bounds queries and validates stable identifiers",()=>{
    expect(libraryIdSchema.safeParse("custom:"+"-".repeat(36)).success).toBe(false);
    expect(libraryIdSchema.safeParse("edb:0025").success).toBe(true);
    expect(libraryQuerySchema.safeParse({limit:5000}).success).toBe(false);
    expect(libraryQuerySchema.safeParse({offset:-1}).success).toBe(false);
    expect(libraryQuerySchema.safeParse({q:"x".repeat(161)}).success).toBe(false);
  });
});
