Action()
{
    web_reg_save_param("sessionID",
        "LB=sid=",
        "RB=&",
        LAST);

    web_url("Home Page",
        "URL=http://www.example.com/index.html",
        "Mode=HTML",
        LAST);

    web_submit_data("Login",
        "Action=http://www.example.com/login",
        "Method=POST",
        "Mode=HTML",
        "Name=username", "Value={UserName}",
        "Name=password", "Value={Password}",
        LAST);

    web_custom_request("API Call",
        "URL=http://www.example.com/api/data",
        "Method=POST",
        "Mode=HTTP",
        "Body=action=get&id=123",
        LAST);

    return 0;
}
