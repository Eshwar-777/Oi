I want to build an AI agent namely "OI" which is interactive in many ways

as part of this i need 3 applications 
1. A website which will let user download the application (something as simple as this https://cursor.com/download)
2. An application which runs on a local PC
3. An application which runs on a mobile 

what can this OI do ?
1. A AI chat interface to chat like any other chatbot . inputs can be text , pictures , live voice , recorded voice , documents
2. There should be the following tabs which are the core features of OI
   a. Converse -> this is the traditional AI chat bot like chatgpt 
   b. Curate -> this is where user will plan the things to automate
   c. Companion -> this is tab automation of tasks take place
   d. Consult -> this is where any input needed from user will be taken if needed 

   example: Lets say concert tickets for ed shareen opens at 4pm today and user cannot book it due to office meetings . so he curates OI 
   a plan . ' book ed shareen concert tickets today at 4pm ' . Now companion will start the curated task at 4pm through UI / API if has 
   access to APIs . if there is any action a BOT can't do like checking the boxes finding cycles etc (basically bot detection bypass) 
   user will get a notification about it and once user opens our mobile application OI will show the UI to be clicked by user (basically 
   user should take action on it). Or additionally if user know that he will be busy at that time user can add another user to be 
   notified as well (say this wife) this other user also should have our OI application to make the action . its basically a mesh of 
   users (so one user can add multiple devices and multiple users can have a shared context -> this is like another user can take action 
   on current user's behalf)
3. when users want to automate some web action all the required websites should be grouped under OI in the browser (let me know if i can 
   control the UI using browser grouping or if i can have an extension to take care of UI actions automation or any other way i can do 
   UI navigation seamlessly)
4. whenever there is an action OI can't do , it should notify user to make the required action and click on continue for you to do the  
   rest
5. these applications should allow user to show something via camera or via screen share and ask something about whatever is present on
   the camera or shares screen
6. OI should have a voice associated with it -> (how can i give a voice ? any google api is there then you can use it , ill provide the
   env variables)

Design of OI

color pallette : #751636 , #33101c , whites , blacks -> mostly use maroons and whites

Design in such a way that it is modular for the user and ease of use should be the priority

let me know what technologies are needed and list of all the todos and services to be brought up
i have access to google cloud , ADK , vertex AI and all the services needed
leverage AI development as well like adding skills etc.., 
let me know how many repositories to have like one for frontend , one for backend , one for mobile application like so

Resources which can be used
https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/multimodal-live-api
https://github.com/GoogleCloudPlatform/generative-ai/tree/main/vision
https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/computer-use
https://github.com/ZackAkil/immersive-language-learning-with-live-api
https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia
https://medium.com/google-cloud/adk-bidi-streaming-a-visual-guide-to-real-time-multimodal-ai-agent-development-62dd08c81399?postPublishedType=repub
https://www.youtube.com/watch?v=vLUkAGeLR1k
https://google.github.io/adk-docs/streaming/dev-guide/part1/
https://www.youtube.com/watch?v=Hwx94smxT_0
https://codelabs.developers.google.com/way-back-home-level-0/instructions#7
https://codelabs.developers.google.com/way-back-home-level-1/instructions#0
https://codelabs.developers.google.com/codelabs/survivor-network/instructions#0
https://codelabs.developers.google.com/way-back-home-level-3/instructions#0
https://codelabs.developers.google.com/way-back-home-level-4/instructions#0

